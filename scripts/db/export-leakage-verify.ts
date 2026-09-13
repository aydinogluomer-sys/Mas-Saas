// Faz 17-38 denetimi — "does an export/search hand a tier rows RLS hides from it?"
//
// WHY THIS GATE EXISTS, AND WHAT IT REFUSES TO ACCEPT AS AN ANSWER.
//
// /api/analytics/export and /api/search both READ code that says they use getPool() — the
// role-scoped pool. Reading that is not evidence. The Faz 24B lesson this repository already
// wrote down is that a denied SELECT and an empty table look identical, so a leak test that only
// checks "the low tier got nothing" proves nothing at all: it passes just as happily when the
// fixture was never created. Every negative below therefore has a POSITIVE CONTROL on the same
// row through a connection that MAY see it.
//
// HOW IT CONNECTS
//
//   owner        MIGRATION_DATABASE_URL. Fixtures only — a superuser bypasses RLS, so no verdict
//                is ever taken on this connection.
//   tier pool    the same mechanism src/lib/db.ts uses in production: per checkout,
//                `select set_config('app.user_id', …)` and then `SET ROLE mas_radar_<tier>`.
//                MEASURED before being relied on: after SET ROLE, current_user is the tier and
//                pg_roles.rolsuper is false, and `select … from schema_migrations` is refused
//                with "permission denied". Each tier block re-asserts that, so a regression where
//                SET ROLE silently failed to take effect could not be mistaken for a pass.
//
// SELF-PROVISIONING, like its siblings in this directory (constraints/transitions/reconciliation/
// legacy-repair-verify): it builds and drops its own database and IGNORES any DATABASE_URL it is
// handed, because a gate whose blast radius depends on an environment variable is a gate with a
// blast radius. Note the deliberate contrast with scripts/phase*-verify.ts, which DO take the
// target from outside (they chain state between phases) and are guarded instead by
// requireDisposableOwnerDatabaseUrl().
//
// PHASE 7 — SUPERUSER KİMLİĞİ. Hedef veritabanının ADI hâlâ sabittir ve dışarıdan alınmaz
// (yukarıdaki kural aynen geçerli). Değişen tek şey KİMLİK/ADRES: eskiden
// `postgres:postgres@127.0.0.1:5432` sabitti — CI ve sıfırdan kurulan dev container için doğru,
// ama superuser parolası rotasyona uğramış gerçek makinede gate `password authentication failed`
// ile hiç koşamıyordu (docs/ops/password-rotation.md; Phase 7 kanıtı 13-export-leakage.json).
// Artık kimlik `MIGRATION_DATABASE_URL`'den (ortam ya da .env.local) alınır ve yalnız veritabanı
// adı sabit disposable adla DEĞİŞTİRİLİR; ikisi de yoksa eski varsayılan kullanılır. Dize hiçbir
// yerde basılmaz. Blast radius değişmedi: bağlanılan tek veritabanı yine
// `mas_radar_export_leakage_verify`'dır ve `assertSafeDisposableName` bunu her yolda doğrular.
//
// Usage:
//   pnpm db:export-leakage:verify
//   (gerçek makinede: MIGRATION_DATABASE_URL ortamda ya da .env.local'de — yalnız kimlik için)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { APP_ROLES, DB_ROLE, type AppRole } from "../../src/lib/authz/matrix";
import { readEnvLocal, swapDatabase } from "./app-url";

const ROOT = process.cwd();
const CONTAINER = process.env.MAS_DB_CONTAINER ?? "mas-radar-pg";
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRATE_SCRIPT = path.join(ROOT, "scripts", "db", "migrate.ts");
const BOOTSTRAP_SQL = path.join(ROOT, "scripts", "db", "local-bootstrap.sql");

const DB = "mas_radar_export_leakage_verify";
const DISPOSABLE_PREFIX = "mas_radar_export_leakage_verify";
const FORBIDDEN_DB_NAME = "mas_radar_dev";

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Fail-closed identity gate — same shape as legacy-repair-verify.ts. */
function assertSafeDisposableName(name: string, context: string): void {
  if (name === FORBIDDEN_DB_NAME) {
    console.error(`GÜVENLİK DURDURMASI (${context}): hedef DB adı '${FORBIDDEN_DB_NAME}' — gerçek veritabanına asla dokunulmaz.`);
    process.exit(1);
  }
  if (!name.startsWith(DISPOSABLE_PREFIX)) {
    console.error(`GÜVENLİK DURDURMASI (${context}): hedef DB adı '${name}', beklenen disposable önek '${DISPOSABLE_PREFIX}' ile başlamıyor.`);
    process.exit(1);
  }
}

function docker(args: string[], input?: Buffer | string): string {
  return execFileSync("docker", args, { input, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}
/** Superuser kimliği: ortam → .env.local → CI varsayılanı. Yol/veritabanı adı buradan ALINMAZ. */
function superuserBaseUrl(): { url: string; origin: string } {
  const fromEnv = process.env.MIGRATION_DATABASE_URL;
  if (fromEnv) return { url: fromEnv, origin: "MIGRATION_DATABASE_URL (ortam)" };
  try {
    const local = readEnvLocal().MIGRATION_DATABASE_URL;
    if (local) return { url: local, origin: "MIGRATION_DATABASE_URL (.env.local)" };
  } catch { /* .env.local yok (CI) */ }
  return { url: "postgres://postgres:postgres@127.0.0.1:5432/postgres", origin: "CI varsayılanı (postgres:postgres@127.0.0.1:5432)" };
}
const SUPERUSER = superuserBaseUrl();

function dbUrl(db: string): string {
  assertSafeDisposableName(db, "bağlantı");
  return swapDatabase(SUPERUSER.url, db);
}

function assertContainerReachable(): void {
  try { docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-q"]); }
  catch {
    console.error(`PostgreSQL konteyneri (${CONTAINER}) erişilebilir değil. Bu script onu otomatik başlatmaz.`);
    process.exit(1);
  }
}

function buildDatabase(): void {
  assertSafeDisposableName(DB, "kurulum");
  docker(["exec", CONTAINER, "dropdb", "-U", "postgres", "--if-exists", DB]);
  docker(["exec", CONTAINER, "createdb", "-U", "postgres", DB]);
  docker(["exec", "-i", CONTAINER, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", DB],
    readFileSync(BOOTSTRAP_SQL));
  execFileSync(process.execPath, [TSX_CLI, MIGRATE_SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl(DB), MIGRATION_DATABASE_URL: dbUrl(DB) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * A Pool that behaves like production's getPool() for one fixed identity.
 *
 * Deliberately the SAME two statements src/lib/db.ts issues, in the same order (set_config before
 * SET ROLE — app.user_id must be written while the connection still may write it). Engine
 * functions receive this and cannot tell it apart from the real thing, which is the point: the
 * assertions below run through the ACTUAL export/search/saved-view code, not a re-implementation.
 */
function tierPool(base: Pool, tier: AppRole, userId: string | null): Pool {
  const prepare = async (client: PoolClient) => {
    await client.query("select set_config('app.user_id', $1, false)", [userId ?? ""]);
    await client.query(`set role ${DB_ROLE[tier]}`);
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return async (...args: unknown[]): Promise<QueryResult<QueryResultRow>> => {
          const client = await base.connect();
          try {
            await prepare(client);
            // @ts-expect-error — pg's query() overloads are wider than this passthrough expresses.
            return await client.query(...args);
          } finally {
            await client.query("reset role").catch(() => undefined);
            client.release();
          }
        };
      }
      if (prop === "connect") {
        return async (): Promise<PoolClient> => {
          const client = await base.connect();
          try { await prepare(client); } catch (e) { client.release(); throw e; }
          const release = client.release.bind(client);
          (client as PoolClient).release = ((...a: unknown[]) => {
            void client.query("reset role").catch(() => undefined).finally(() => release(...(a as [])));
          }) as PoolClient["release"];
          return client;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function main(): Promise<void> {
  console.log("=== export-leakage-verify: rol bazlı sızıntı sondası (disposable DB) ===\n");
  console.log(`superuser kimliği: ${SUPERUSER.origin} · hedef: ${DB} (ad sabit, dize yazdırılmaz)`);
  assertContainerReachable();
  buildDatabase();

  // Set BEFORE the src/ modules load: @/lib/env validates DATABASE_URL as it is imported, and
  // several engines pull it in transitively. Dynamic import for exactly this reason.
  process.env.DATABASE_URL = dbUrl(DB);
  process.env.MIGRATION_DATABASE_URL = dbUrl(DB);

  const { listSavedViews } = await import("../../src/lib/ui/saved-views");
  const { runSearch } = await import("../../src/lib/search/engine");
  const { parseSearchQuery } = await import("../../src/lib/search/nl");
  const { runParetoConcentration, runRollingTrend } = await import("../../src/lib/analytics/engine");

  const owner = new Pool({ connectionString: dbUrl(DB), max: 4 });
  const base = new Pool({ connectionString: dbUrl(DB), max: 6 });

  try {
    /* ── 0. fixtures, on the owner connection ─────────────────────────────────────────── */
    const mkUser = async (username: string, role: AppRole) =>
      (await owner.query<{ id: string }>(
        `insert into public.users (username, password_hash, display_name, role, is_active)
         values ($1,'x',$2,$3,true) returning id`, [username, username, role])).rows[0].id;

    const userA = await mkUser("leak_owner_a", "finance_operator");
    const userB = await mkUser("leak_other_b", "finance_operator");
    await mkUser("leak_admin_c", "admin"); // en az bir aktif admin — 0031'in değişmezi

    // A'ya ait, B'nin görmemesi gereken satırlar.
    const viewA = (await owner.query<{ id: string }>(
      `insert into public.saved_views (name, module_key, filters, is_shared, is_default, created_by)
       values ('A-OZEL-GORUNUM','finance','{}'::jsonb,false,false,$1) returning id`, [userA])).rows[0].id;
    const itemA = (await owner.query<{ id: string }>(
      `insert into public.action_items (title, status, created_by)
       values ('A-OZEL-GOREV','open',$1) returning id`, [userA])).rows[0].id;
    const convoA = (await owner.query<{ id: string }>(
      `insert into public.assistant_conversations (title, created_by)
       values ('A-OZEL-KONUSMA',$1) returning id`, [userA])).rows[0].id;

    // FİNANSAL FIXTURE — "sessizce boş" kontrolünün ölçecek bir şeyi olması için ZORUNLU.
    //
    // İlk yazılışında bu yoktu ve export kontrolleri 0 satırla FAIL verdi. Sebep bir sızıntı
    // değildi: taze migrate edilmiş bir veritabanında hiç finansal kayıt yoktur, dolayısıyla
    // izleyicinin çıktısı da yöneticininki de haklı olarak boştu. Assertion doğruydu, KURULUM
    // eksikti — bu yüzden assertion gevşetilmedi, fixture eklendi. Boş bir veritabanında
    // "sızıntı yok" demek, tam da bu gate'in başında reddedilen vakumda-geçme durumudur.
    const party = (await owner.query<{ id: string }>(
      `insert into public.parties (name, normalized_name, party_type)
       values ('LEAK-MUSTERI','leak-musteri','customer') returning id`)).rows[0].id;
    await owner.query(
      `insert into public.invoices (direction, invoice_no, party_id, issue_date,
                                    net_amount, tax_amount, gross_amount, status)
       values ('sales','LEAK-INV-1',$1, current_date - 10, 1000, 200, 1200, 'open')`, [party]);
    const pay = (await owner.query<{ id: string }>(
      `insert into public.payments (name, recurrence_type, due_day, status)
       values ('LEAK-ODEME','monthly',15,'active') returning id`)).rows[0].id;
    // AY BAŞINA BİR KALEM: payment_instances_idempotency (payment_id, instance_month) üzerinde
    // benzersiz. Aynı aya iki kalem yazmak testin kendi kurulumunu düşürürdü — ilk yazılışında
    // düşürdü de. Geçmiş dört ay seçiliyor ki her vade current_date'ten küçük kalsın
    // (runRollingTrend yalnız due_date <= current_date olan kalemleri topluyor).
    for (const monthsAgo of [1, 2, 3, 4]) {
      await owner.query(
        `insert into public.payment_instances (payment_id, instance_month, due_date, amount, status)
         values ($1,
                 (date_trunc('month', current_date) - ($2::int || ' month')::interval)::date,
                 (date_trunc('month', current_date) - ($2::int || ' month')::interval)::date + 14,
                 500, 'unpaid')`,
        [pay, monthsAgo]);
    }
    record("finansal fixture kuruldu (export analizlerinin ölçecek verisi var)",
      Number((await owner.query<{ n: string }>(
        `select count(*)::text n from public.payment_instances`)).rows[0].n) === 4,
      "1 açık satış faturası + 4 ödeme kalemi");

    record("fixture kuruldu (A'ya ait kayıtlar owner bağlantısında görünüyor)",
      (await owner.query(`select 1 from public.saved_views where id=$1`, [viewA])).rowCount === 1
      && (await owner.query(`select 1 from public.action_items where id=$1`, [itemA])).rowCount === 1
      && (await owner.query(`select 1 from public.assistant_conversations where id=$1`, [convoA])).rowCount === 1,
      "üç owner-scoped satır");

    /* ── 1. the mechanism itself, before any verdict rests on it ──────────────────────── */
    for (const tier of APP_ROLES) {
      const p = tierPool(base, tier, userB);
      const who = await p.query<{ u: string; s: boolean }>(
        `select current_user as u, (select rolsuper from pg_roles where rolname=current_user) as s`);
      record(`SET ROLE gerçekten uygulandı: ${tier}`,
        who.rows[0].u === DB_ROLE[tier] && who.rows[0].s === false,
        `current_user=${who.rows[0].u} superuser=${who.rows[0].s}`);
    }

    /* ── 2. ledger class: no tier may read schema_migrations at all ───────────────────── */
    const ownerLedger = Number((await owner.query<{ n: string }>(
      `select count(*)::text n from public.schema_migrations`)).rows[0].n);
    record("POZİTİF KONTROL: ledger owner'a GÖRÜNÜYOR (boş tabloyla karıştırılmıyor)",
      ownerLedger > 0, `${ownerLedger} satır`);
    for (const tier of APP_ROLES) {
      const p = tierPool(base, tier, userB);
      let denied = false;
      try { await p.query(`select count(*) from public.schema_migrations`); }
      catch (e) { denied = /permission denied/i.test(messageOf(e)); }
      record(`ledger ${tier} katmanına KAPALI`, denied, "schema_migrations hiçbir katmana açık değil");
    }

    /* ── 3. owner-scoped rows, addressed BY ID — the "direct-id" attack ───────────────── */
    //
    // B, A'nın satırının kimliğini biliyor (URL'den, bir bağlantıdan, tahminle). Liste yolunu
    // atlayıp doğrudan o kimliği soruyor. RLS bunu da reddetmeli, çünkü listeyi filtrelemek
    // yeterli olsaydı kimliği bilen herkes filtreyi atlardı.
    const asOfToday = new Date().toISOString().slice(0, 10);
    const asA = tierPool(base, "finance_operator", userA);
    const asB = tierPool(base, "finance_operator", userB);

    // İKİ AYRI KATEGORİ VAR VE BUNU KARIŞTIRMAK TESTİ YANLIŞ KURAR — ilk yazılışında karıştı.
    //
    // İlk hâli action_items'ı da "B görememeli" diye sınıyordu ve FAIL verdi. Katalog bakıldı:
    //   action_items            SELECT qual = true                                (herkes okur)
    //                           UPDATE qual = created_by = current_app_user()     (sahibi yazar)
    //   saved_views             SELECT qual = is_shared OR created_by = current_app_user()
    //   assistant_conversations SELECT qual = created_by = current_app_user()
    // Yani action_items TASARIM GEREĞİ şirket içi ortak iş kaydıdır: okuma geniş, YAZMA sahibine
    // dar. Ürün doğru davranıyordu, testin beklentisi yanlıştı. Assertion gevşetilmedi — yanlış
    // kategoriye konmuş tablo doğru kategoriye taşındı ve iki kategori ayrı ayrı sınanıyor.

    // (a) OKUMASI SAHİPLİĞE BAĞLI olanlar: B, A'nın satırını kimlikle bile göremez.
    for (const probe of [
      { table: "saved_views", id: viewA, label: "kayıtlı görünüm" },
      { table: "assistant_conversations", id: convoA, label: "asistan konuşması" },
    ]) {
      const seenByA = (await asA.query(`select id from public.${probe.table} where id = $1`, [probe.id])).rowCount ?? 0;
      const seenByB = (await asB.query(`select id from public.${probe.table} where id = $1`, [probe.id])).rowCount ?? 0;
      record(`POZİTİF KONTROL: sahibi (A) kendi ${probe.label} satırını KİMLİKLE görüyor`,
        seenByA === 1, `${seenByA} satır`);
      record(`DOĞRUDAN-KİMLİK: başkası (B) A'nın ${probe.label} satırını GÖREMİYOR`,
        seenByB === 0, `${seenByB} satır`);
      const upd = await asB.query(
        `update public.${probe.table} set updated_at = now() where id = $1`, [probe.id]).catch(() => ({ rowCount: 0 }));
      record(`DOĞRUDAN-KİMLİK: B, A'nın ${probe.label} satırını DEĞİŞTİREMİYOR`,
        (upd.rowCount ?? 0) === 0, `${upd.rowCount ?? 0} satır etkilendi`);
    }

    // (b) OKUMASI GENİŞ, YAZMASI SAHİPLİĞE BAĞLI olan: action_items.
    // Burada "B göremiyor" beklemek yanlış olurdu; doğru beklenti "B okur ama yazamaz".
    {
      const seenByB = (await asB.query(`select id from public.action_items where id = $1`, [itemA])).rowCount ?? 0;
      record("action_items TASARIM GEREĞİ okunabilir (ortak iş kaydı, gizli değil)",
        seenByB === 1, `B ${seenByB} satır görüyor — SELECT qual = true`);
      const upd = await asB.query(
        `update public.action_items set title = 'B-ELE-GECIRDI' where id = $1`, [itemA]).catch(() => ({ rowCount: 0 }));
      record("DOĞRUDAN-KİMLİK: B, A'nın aksiyon kaydını DEĞİŞTİREMİYOR (yazma sahipliğe dar)",
        (upd.rowCount ?? 0) === 0, `${upd.rowCount ?? 0} satır etkilendi`);
      const title = (await owner.query<{ title: string }>(
        `select title from public.action_items where id = $1`, [itemA])).rows[0].title;
      record("A'nın aksiyon kaydının başlığı DEĞİŞMEDİ (owner bağlantısıyla doğrulandı)",
        title === "A-OZEL-GOREV", `title=${title}`);
    }

    // (c) Politikanın gerçekten AYRIM YAPTIĞI — kör bir red olmadığı.
    // saved_views SELECT qual'i `is_shared OR created_by = current_app_user()`. PAYLAŞILAN bir
    // görünüm B'ye GÖRÜNMELİ; görünmezse kapı "her şeyi reddet"e dönmüş demektir ve yukarıdaki
    // negatiflerin hiçbiri bir şey kanıtlamaz.
    const sharedA = (await owner.query<{ id: string }>(
      `insert into public.saved_views (name, module_key, filters, is_shared, is_default, created_by)
       values ('A-PAYLASILAN-GORUNUM','finance','{}'::jsonb,true,false,$1) returning id`, [userA])).rows[0].id;
    record("POZİTİF KONTROL: A'nın PAYLAŞILAN görünümü B'ye GÖRÜNÜYOR (politika ayrım yapıyor)",
      ((await asB.query(`select id from public.saved_views where id = $1`, [sharedA])).rowCount ?? 0) === 1,
      "is_shared OR created_by — 'her şeyi reddet' değil");

    /* ── 4. the saved-view READ PATH, through the real engine ─────────────────────────── */
    const aViews = await listSavedViews(asA, "finance", userA);
    const bViews = await listSavedViews(asB, "finance", userB);
    record("POZİTİF KONTROL: listSavedViews A'ya kendi görünümünü veriyor",
      aViews.some((v) => v.name === "A-OZEL-GORUNUM"), `${aViews.length} görünüm`);
    record("KAYITLI GÖRÜNÜM OKUMA YOLU: B, A'nın görünümünü listede GÖRMÜYOR",
      !bViews.some((v) => v.name === "A-OZEL-GORUNUM"), `${bViews.length} görünüm`);

    /* ── 5. SEARCH — the same rows, through the universal search path ─────────────────── */
    // Rotanın kendisiyle AYNI kurucu: parseSearchQuery(q, todayISO) — ikinci bir intent kurucusu
    // ikinci bir arama davranışı demek olurdu.
    const intent = parseSearchQuery("A-OZEL", asOfToday);
    const aHits = await runSearch(asA, intent, 8);
    const bHits = await runSearch(asB, intent, 8);
    const leakedInSearch = bHits.hits.filter((h) => /A-OZEL-GORUNUM|A-OZEL-KONUSMA/.test(JSON.stringify(h)));
    record("ARAMA: B'nin arama sonuçlarında A'ya ait SAHİPLİK KAPSAMLI hiçbir kayıt yok",
      leakedInSearch.length === 0,
      leakedInSearch.length ? JSON.stringify(leakedInSearch).slice(0, 200) : `${bHits.hits.length} isabet, sızıntı yok`);
    record("POZİTİF KONTROL: arama yolu ÇALIŞIYOR (A kendi kaydını arayabiliyor ya da entity kapsam dışı)",
      aHits.searchedEntities.length > 0, `${aHits.searchedEntities.length} varlık tarandı, ${aHits.hits.length} isabet`);

    /* ── 6. EXPORT — the analyses the route actually runs, under a tier ───────────────── */
    //
    // DÜRÜST BULGU, GİZLENMİYOR: /api/analytics/export'un çalıştırdığı yedi analizin OKUDUĞU her
    // tablo beş katmanın hepsine SELECT veriyor (0058'in "geniş okuma, dar yazma" biçimi). Yani
    // bu analizlerde katmana göre farklılaşan bir satır YOKTUR ve olmamalıdır. O yüzden burada
    // kanıtlanması gereken şey iki yönlü:
    //   (a) düşük katmanın çıktısı SESSİZCE BOŞ DÖNMÜYOR (asıl gerçekçi regresyon bu olurdu:
    //       RLS bir tabloyu kapatır, export sessizce boş bir sayfa üretir, kimse fark etmez),
    //   (b) düşük katmanın çıktısı yönetici çıktısıyla BİREBİR aynı — yani export ne eksik
    //       veriyor ne de fazla.
    const asOf = asOfToday;
    const viewerPool = tierPool(base, "viewer", userB);
    const adminPool = tierPool(base, "admin", userB);
    for (const [label, run] of [
      ["pareto_concentration", runParetoConcentration],
      ["rolling_trend", (p: Pool, d: string) => runRollingTrend(p, 30, d)],
    ] as const) {
      const v = await (run as (p: Pool, d: string) => Promise<{ result: { rows: unknown[] } }>)(viewerPool, asOf);
      const a = await (run as (p: Pool, d: string) => Promise<{ result: { rows: unknown[] } }>)(adminPool, asOf);
      record(`EXPORT ${label}: izleyici çıktısı SESSİZCE BOŞ değil`,
        v.result.rows.length > 0, `${v.result.rows.length} satır`);
      record(`EXPORT ${label}: izleyici ve yönetici çıktısı BİREBİR aynı (ne eksik ne fazla)`,
        JSON.stringify(v.result.rows) === JSON.stringify(a.result.rows),
        `izleyici=${v.result.rows.length} yönetici=${a.result.rows.length}`);
    }

    /* ── 7. structural: the routes take the SCOPED pool, never the raw one ────────────── */
    const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
    for (const route of ["src/app/api/analytics/export/route.ts", "src/app/api/search/route.ts"]) {
      const src = readSrc(route);
      record(`${route}: rol-kapsamlı getPool() kullanıyor, getRawPool() KULLANMIYOR`,
        /getPool\(\)/.test(src) && !/getRawPool/.test(src),
        "ham havuz oturum arama yolunun kimliğidir; bir dışa aktarım onu asla almamalı");
      record(`${route}: oturumsuz istek reddediliyor`,
        /getCurrentUser\(\)/.test(src) && /401/.test(src), "");
    }

    /* ── 8. ledger sızıntısının export yüzeyinde de olmadığı ──────────────────────────── */
    // schema_migrations'ı okuyan bir analiz eklenirse bu kontrol düşer.
    const exportSrc = readSrc("src/app/api/analytics/export/route.ts");
    record("export rotası ledger/oturum tablolarına hiç dokunmuyor",
      !/schema_migrations|public\.sessions|password_hash|token_hash/.test(exportSrc),
      "dışa aktarım yüzeyi finansal analizle sınırlı");
  } finally {
    await base.end().catch(() => undefined);
    await owner.end().catch(() => undefined);
    assertSafeDisposableName(DB, "temizlik");
    docker(["exec", CONTAINER, "dropdb", "-U", "postgres", "--if-exists", DB]);
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length) {
    console.log(`EXPORT LEAKAGE VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("EXPORT LEAKAGE VERIFY: ALL PASS");
}

main().catch((e) => {
  console.error("export-leakage-verify beklenmedik hata ile durdu:", messageOf(e));
  try {
    assertSafeDisposableName(DB, "hata temizliği");
    docker(["exec", CONTAINER, "dropdb", "-U", "postgres", "--if-exists", DB]);
  } catch { /* temizlik en iyi çaba */ }
  process.exit(1);
});
