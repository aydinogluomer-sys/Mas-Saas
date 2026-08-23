// Faz 35 verification — document centre, universal search, NL boundary, and THE RLS PROOF.
//
// Usage:
//   env -u DATABASE_URL MIGRATION_DATABASE_URL=... pnpm phase35:verify
//
// The owner connection is enough for everything except the role-scoped search test, which needs a
// real low-privilege login. That connection is derived from MIGRATION_DATABASE_URL by swapping the
// role, and MAS_RADAR_APP_DB_PASSWORD supplies its password (same env var
// scripts/db/set-app-role-password.ts uses). When it is absent the RLS checks FAIL LOUDLY rather
// than being skipped — a security check that quietly does not run is worse than no check.
//
// ═══ THE CENTRAL REQUIREMENT: SEARCH MUST NEVER BYPASS FAZ 24B'S RLS ═══
//
// The trap this phase was warned about is real and common: run search over one wide connection
// "for performance", filter in application code, and every tier silently gets rows the rest of
// the product hides from them. This gate refuses to take the code's word for it and proves the
// property three ways:
//
//   STRUCTURALLY — src/lib/search/* never obtains a connection. No `new Pool`, no getPool, no
//   getRawPool, no runAsSystem. It takes the pool the caller already had.
//
//   BY CLASSIFICATION — no table in the search registry is one that some tier cannot read, so
//   search cannot become the one screen where a restricted table appears.
//
//   BEHAVIOURALLY — the SAME search function is executed over a REAL unswitched app connection
//   and over a REAL `SET ROLE` connection, against a fixture the owner can see. Unswitched must
//   return zero; the switched tier must return the row. Both halves matter: without the second,
//   "zero rows" would pass for the wrong reason.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { SEARCH_ENTITIES, SEARCH_ENTITY_KEYS } from "../src/lib/search/registry";
import { parseSearchQuery, reconcileModelIntent, searchIntentSchema } from "../src/lib/search/nl";
import { runSearch, groupHits } from "../src/lib/search/engine";
import { sha256, storagePathFor, storeFile, verifyStored } from "../src/lib/documents/storage";
import { CLASS_MATRIX, TABLE_CLASS, can, APP_ROLES, DB_ROLE } from "../src/lib/authz/matrix";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const ownerUrl = requireDisposableOwnerDatabaseUrl("phase35:verify");
const pool = new Pool({ connectionString: ownerUrl });

/** Same database, but as the low-privilege runtime role — the connection the app really uses. */
function appUrl(): string | null {
  const pw = process.env.MAS_RADAR_APP_DB_PASSWORD;
  if (!pw) return null;
  const u = new URL(ownerUrl);
  u.username = "mas_radar_app";
  u.password = pw;
  return u.toString();
}

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ROOT = process.cwd();
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/^\s*--.*$/gm, " ");

function walkSources(relDir: string): string[] {
  const abs = path.join(ROOT, relDir);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const rel = path.join(relDir, e);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walkSources(rel));
    else if (/\.(ts|tsx)$/.test(e)) out.push(rel.replace(/\\/g, "/"));
  }
  return out;
}

const TAG = "P35-FIXTURE";
const purge = async () => {
  await pool.query(`delete from public.documents where title like $1`, [`${TAG}%`]).catch(() => undefined);
};

async function main(): Promise<void> {
  await purge();

  /* ── 1. schema: documents / attachments / links ─────────────────────────────────────── */
  const tables = await pool.query(`
    select table_name from information_schema.tables
    where table_schema='public' and table_name in ('documents','attachments','document_links')`);
  record("documents + attachments + document_links tabloları var",
    tables.rowCount === 3, tables.rows.map((r) => r.table_name).join(", "));

  const shaCol = await pool.query(`
    select is_nullable from information_schema.columns
    where table_schema='public' and table_name='attachments' and column_name='file_sha256'`);
  record("attachments.file_sha256 NOT NULL (0001'den daha sıkı, bilerek)",
    shaCol.rows[0]?.is_nullable === "NO",
    "yerel diskin bedeli: restore, hangi dosyanın kayıp/bozuk olduğunu KANITLAYABİLMELİ");

  // Structural constraint targeting via conkey, cardinality asserted (not "at least one").
  const statusCheck = await pool.query(`
    select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
    where c.conrelid='public.documents'::regclass and c.contype='c'
      and a.attname='status' and array_length(c.conkey,1)=1`);
  record("documents.status CHECK'i conkey ile YAPISAL hedeflendi",
    statusCheck.rowCount === 1, `${statusCheck.rowCount} kısıt`);
  const statusDef = String(statusCheck.rows[0]?.def ?? "");
  record("status CHECK'i üç durumu taşıyor",
    ["active", "archived", "superseded"].every((s) => statusDef.includes(`'${s}'`)),
    "active, archived, superseded");

  /* ── 2. transition guard: SQL allow-list, and it really refuses ─────────────────────── */
  const guard = await pool.query(
    `select prosrc from pg_proc where proname='documents_guard_transition'`);
  const pairs = new Set([...codeOnly(String(guard.rows[0]?.prosrc ?? ""))
    .matchAll(/\('(\w+)',\s*'(\w+)'\)/g)].map((m) => `${m[1]}->${m[2]}`));
  record("geçiş koruyucusu CHECK ile AYNI migration'da ve dört hamle tanımlı",
    pairs.size === 4 && pairs.has("active->archived") && pairs.has("archived->active"),
    [...pairs].join(", "));

  const mk = async (status = "active", extra = "") => {
    const r = await pool.query(
      `insert into public.documents (title, doc_type, status ${extra ? ", " + extra.split("=")[0] : ""})
       values ($1, 'other', $2 ${extra ? ", " + extra.split("=")[1] : ""}) returning id`,
      [`${TAG} ${Math.random().toString(36).slice(2, 8)}`, status]);
    return r.rows[0].id as string;
  };
  const expectReject = async (sql: string, p: unknown[] = []) => {
    try { await pool.query(sql, p); return false; } catch { return true; }
  };

  const supersededDoc = await pool.query(
    `with target as (insert into public.documents (title, doc_type) values ($1,'other') returning id)
     insert into public.documents (title, doc_type, status, superseded_by_document_id)
     select $2, 'other', 'superseded', id from target returning id`,
    [`${TAG} replacement`, `${TAG} superseded`]);
  const supersededId = supersededDoc.rows[0].id as string;
  record("YASAK geçiş reddedildi: superseded → active",
    await expectReject(
      `update public.documents set status='active', superseded_by_document_id=null where id=$1`,
      [supersededId]),
    "canlandırılan bir doküman, ikisi de güncel iddiasında iki doküman demektir");

  const activeId = await mk("active");
  await pool.query(
    `update public.documents set status='archived', archived_at=now(), archive_reason='gate' where id=$1`,
    [activeId]);
  const archivedNow = await pool.query(`select status from public.documents where id=$1`, [activeId]);
  record("POZİTİF KONTROL: izinli geçiş kabul edildi (active → archived)",
    archivedNow.rows[0].status === "archived", "guard her şeyi reddetmiyor");

  record("arşiv tutarlılığı zorunlu (sebepsiz arşiv reddedilir)",
    await expectReject(
      `insert into public.documents (title, doc_type, status, archived_at)
       values ($1,'other','archived', now())`, [`${TAG} bad`]),
    "sebebi olmayan bir arşiv kaydı, kimsenin geri alamayacağı bir karardır");
  record("kendi kendini supersede eden doküman reddedilir",
    await expectReject(
      `update public.documents set status='superseded', superseded_by_document_id=id where id=$1`,
      [activeId]),
    "döngüsel supersede zinciri");

  /* ── 3. attachments append-only ─────────────────────────────────────────────────────── */
  const docForFile = await mk("active");
  const bytes = Buffer.from(`${TAG} içerik ${Date.now()}`);
  const stored = storeFile(bytes);
  const att = await pool.query(
    `insert into public.attachments
       (document_id, version_no, original_filename, storage_path, file_sha256, byte_size, mime_type)
     values ($1,1,'a.pdf',$2,$3,$4,'application/pdf') returning id`,
    [docForFile, stored.storagePath, stored.sha256, stored.byteSize]);
  record("attachments UPDATE reddediliyor (sürüm geçmişi değiştirilemez)",
    await expectReject(`update public.attachments set mime_type='x' where id=$1`, [att.rows[0].id]),
    "düzeltilebilen bir sürüm geçmişi, geçmiş değildir");
  record("attachments DELETE reddediliyor",
    await expectReject(`delete from public.attachments where id=$1`, [att.rows[0].id]), "");
  record("aynı doküman + aynı sha256 ikinci sürüm olarak eklenemiyor",
    await expectReject(
      `insert into public.attachments
         (document_id, version_no, original_filename, storage_path, file_sha256, byte_size, mime_type)
       values ($1,2,'a.pdf',$2,$3,$4,'application/pdf')`,
      [docForFile, stored.storagePath, stored.sha256, stored.byteSize]),
    "birebir aynı baytları 'sürüm 2' diye kaydetmek, olmayan bir değişikliği kaydeder");

  /* ── 4. current-version read model is a VIEW ────────────────────────────────────────── */
  const viewCount = await pool.query(
    `select count(*)::int n from pg_views where schemaname='public' and viewname='document_current_version'`);
  record("güncel sürüm bir VIEW (current_attachment_id kolonu değil)",
    Number(viewCount.rows[0].n) === 1,
    "saklanan bir işaretçi, max(version_no)'nun zaten cevapladığı şey için ikinci kaynaktır");

  /* ── 5. local-disk storage decision, and its cost handled ───────────────────────────── */
  record("içerik adresli yol: kullanıcı metni yola HİÇ girmiyor",
    storagePathFor(sha256(Buffer.from("x"))).split(path.sep).length === 3,
    "dosyanın adı kendi bütünlük kontrolü");
  let pathRefused = false;
  try { storagePathFor("../../etc/passwd"); } catch { pathRefused = true; }
  record("sha256 olmayan yol REDDEDİLİYOR", pathRefused, "dizin dışına çıkış yapısal olarak imkânsız");
  const okReport = verifyStored(stored.storagePath, stored.sha256, stored.byteSize);
  record("bütünlük doğrulaması sağlam dosyayı geçiriyor",
    okReport.present && okReport.hashMatches === true, "");
  const badReport = verifyStored(stored.storagePath, "f".repeat(64), stored.byteSize);
  record("bütünlük doğrulaması BOZUK sağlamayı yakalıyor",
    badReport.hashMatches === false,
    "sessizce bozulmuş dosya sunan bir arşiv, kapalı olandan kötüdür");
  // codeOnly(): the migration EXPLAINS in its header why bytea was rejected, and the first
  // version of this check matched its own documentation. The Faz 27 trap, again.
  const dbSchemaDoc = codeOnly(readSrc("supabase/migrations/0083_documents.sql"));
  record("baytlar veritabanına KONULMADI (bytea/large object yok)",
    !/\bbytea\b|lo_import|large object/i.test(dbSchemaDoc),
    "Faz 33 ölçtü: hacimli dump zaten yedek doğrulamasını kırıyordu");

  /* ── 6. THE RLS PROOF — structural ──────────────────────────────────────────────────── */
  const searchFiles = walkSources("src/lib/search");
  const CONNECTION_GRABS = [/new\s+Pool\s*\(/, /getPool\s*\(/, /getRawPool\s*\(/, /runAsSystem\s*\(/];
  const grabbers = searchFiles.filter((f) => {
    const src = codeOnly(readSrc(f));
    return CONNECTION_GRABS.some((rx) => rx.test(src));
  });
  record("arama modülleri KENDİ bağlantısını almıyor (havuz dışarıdan geliyor)",
    grabbers.length === 0,
    grabbers.join(", ") || `${searchFiles.length} dosya: new Pool / getPool / getRawPool / runAsSystem yok`);
  record("POZİTİF KONTROL: bağlantı-kapma dedektörü deseni gerçekten yakalıyor",
    CONNECTION_GRABS.some((rx) => rx.test("const p = new Pool({});"))
      && CONNECTION_GRABS.some((rx) => rx.test("await runAsSystem(async () => {})")),
    "yakalamayan bir dedektör, temiz olduğunu söyleyen bir dedektördür");

  /* ── 7. THE RLS PROOF — by classification ───────────────────────────────────────────── */
  const unclassified = SEARCH_ENTITY_KEYS.filter((k) => TABLE_CLASS[SEARCH_ENTITIES[k].table] == null);
  record("arama kaydındaki her tablo Faz 24B'de SINIFLANDIRILMIŞ",
    unclassified.length === 0, unclassified.join(", ") || `${SEARCH_ENTITY_KEYS.length} tablo`);
  const invisible: string[] = [];
  for (const key of SEARCH_ENTITY_KEYS) {
    const table = SEARCH_ENTITIES[key].table;
    for (const role of APP_ROLES) {
      if (!can(role, table, "select")) invisible.push(`${role}:${table}`);
    }
  }
  record("arama kaydında HİÇBİR katmanın göremeyeceği tablo YOK",
    invisible.length === 0,
    invisible.join(", ") || "arama, kısıtlı bir tablonun göründüğü tek ekran olamaz");
  const ledgerInRegistry = SEARCH_ENTITY_KEYS.filter(
    (k) => TABLE_CLASS[SEARCH_ENTITIES[k].table] === "ledger");
  record("ledger sınıfı (schema_migrations) aranabilir DEĞİL",
    ledgerInRegistry.length === 0 && CLASS_MATRIX.ledger.viewer.length === 0, "hiçbir katman okuyamaz");

  /* ── 8. THE RLS PROOF — behavioural, with a REAL SET ROLE ───────────────────────────── */
  const searchableDocId = await mk("active");
  await pool.query(`update public.documents set title=$2 where id=$1`,
    [searchableDocId, `${TAG} kira sozlesmesi`]);

  const intent = parseSearchQuery(`${TAG} belge`, new Date().toISOString().slice(0, 10));
  const ownerHits = await runSearch(pool, intent, 20);
  record("sahip bağlantısı fixture dokümanı BULUYOR (karşılaştırma boş kümede değil)",
    ownerHits.hits.some((h) => h.id === searchableDocId),
    `${ownerHits.hits.length} sonuç`);

  const url = appUrl();
  if (!url) {
    // Loud failure, never a silent skip: this is the security requirement of the phase.
    record("RLS davranış testi çalıştırılabildi (MAS_RADAR_APP_DB_PASSWORD gerekli)",
      false, "parola verilmedi — güvenlik kontrolü SESSİZCE ATLANAMAZ");
  } else {
    const appPool = new Pool({ connectionString: url });
    try {
      // (a) UNSWITCHED: the app role with no SET ROLE must see nothing (Faz 24B).
      const unswitchedClient = await appPool.connect();
      let unswitchedHits = -1;
      try {
        const proxy = {
          query: (sql: string, params?: unknown[]) => unswitchedClient.query(sql, params),
        } as unknown as Pool;
        unswitchedHits = (await runSearch(proxy, intent, 20)).hits.length;
      } finally { unswitchedClient.release(); }
      record("KATMANA GEÇMEMİŞ bağlantıda arama SIFIR sonuç veriyor",
        unswitchedHits === 0,
        `${unswitchedHits} sonuç — arama motorunun ayrıcalıklı bir yolu yok`);

      // (b) SET ROLE viewer: must see the document (positive control), proving (a) was not zero
      //     for some unrelated reason.
      const viewerClient = await appPool.connect();
      let viewerHits: string[] = [];
      try {
        await viewerClient.query(`set role ${DB_ROLE.viewer}`);
        const proxy = {
          query: (sql: string, params?: unknown[]) => viewerClient.query(sql, params),
        } as unknown as Pool;
        viewerHits = (await runSearch(proxy, intent, 20)).hits.map((h) => h.id);
        await viewerClient.query("reset role");
      } finally { viewerClient.release(); }
      record("POZİTİF KONTROL: SET ROLE viewer aynı aramada dokümanı GÖRÜYOR",
        viewerHits.includes(searchableDocId),
        `${viewerHits.length} sonuç — (a)'daki sıfır, RLS yüzünden`);

      // (c) A tier must never reach a table it has no SELECT on, even by asking directly.
      const ledgerClient = await appPool.connect();
      let ledgerRefused = false;
      try {
        await ledgerClient.query(`set role ${DB_ROLE.viewer}`);
        await ledgerClient.query(`select count(*) from public.schema_migrations`);
      } catch { ledgerRefused = true; } finally {
        await ledgerClient.query("reset role").catch(() => undefined);
        ledgerClient.release();
      }
      record("viewer ledger tablosunu DOĞRUDAN da okuyamıyor",
        ledgerRefused, "arama kapsamı dışında olması tesadüf değil, katman da reddediyor");
    } finally {
      await appPool.end();
    }
  }

  /* ── 9. NL boundary: model may narrow, never widen, never write SQL ─────────────────── */
  record("model çıktısı kayıt dışı bir entity ADLANDIRAMIYOR (Zod enum)",
    searchIntentSchema.safeParse({ entities: ["users"] }).success === false
      && searchIntentSchema.safeParse({ entities: ["parties; drop table invoices"] }).success === false,
    "model bir tablo adı ekleyemez — böyle bir kod yolu yok");
  const det = parseSearchQuery("akon faturaları", "2026-03-31");
  const widened = reconcileModelIntent(det, { entities: ["invoices", "audit_logs"], text: "x" });
  record("model KAPSAMI GENİŞLETEMİYOR (prompt injection savunması)",
    !widened.intent.entities.includes("audit_logs") && widened.intent.entities.includes("invoices"),
    "kullanıcı 'fatura' dedi; model 'her şeyi ara' diyemez");
  record("model arama METNİNİ yeniden yazamıyor",
    reconcileModelIntent(det, { entities: ["invoices"], text: "baska bir sey" }).intent.text === det.text,
    "aksi hâlde kullanıcının sormadığı şey aranırdı");
  record("bozuk model çıktısında deterministik ayrıştırmaya DÖNÜLÜYOR",
    reconcileModelIntent(det, { entities: ["nope"] }).accepted === false,
    "API anahtarı bittiğinde çalışmayı durduran şey arama değildir");

  const nlSrc = codeOnly(readSrc("src/lib/search/nl.ts"));
  const engineSrc = codeOnly(readSrc("src/lib/search/engine.ts"));
  const AI_IMPORT = new RegExp(`from\\s+["']@/lib/${"ai"}(/|["'])`);
  record("arama modülleri @/lib/ai'yi import ETMİYOR",
    !AI_IMPORT.test(nlSrc) && !AI_IMPORT.test(engineSrc),
    "LLM yalnız niyet çıkarımı için, ve bu dosyalar onu bile çağırmıyor");
  record("sorgu üreteci SELECT dışında bir ifade kurmuyor",
    !/\b(insert|update|delete|drop|truncate|alter)\b/i.test(engineSrc),
    "arama okur");
  // Structural, not a brittle template match: EVERY use of intent.* in the engine must appear as
  // an argument to params.push() — i.e. as a bound parameter. Any other use would mean user text
  // reaching the statement text itself. The first version pinned an exact source line and failed
  // on its own formatting, which proves nothing about safety either way.
  const rawEngine = readSrc("src/lib/search/engine.ts");
  // Target the two constructs that BUILD SQL, not every mention of `intent`: reading
  // `if (intent.text)` to decide whether to add a clause is not concatenation, and counting it as
  // such made the first version of this check fail while the code was correct.
  const whereFragments = [...rawEngine.matchAll(/where\.push\(([^;]*)\)/g)].map((m) => m[1]);
  const sqlTemplate = rawEngine.match(/const sql = `([\s\S]*?)`;/)?.[1] ?? "";
  const leakingWhere = whereFragments.filter((f) => /intent\./.test(f));
  record("kullanıcı metni SQL'e KONKATENE edilmiyor (yalnız bağlı parametre)",
    whereFragments.length > 0 && sqlTemplate.length > 0
      && leakingWhere.length === 0 && !/intent\./.test(sqlTemplate),
    `${whereFragments.length} where parçası + sql şablonu: hiçbirinde intent. yok — ` +
    `değerler yalnız params.push() ile $N olarak gidiyor`);

  /* ── 10. search behaviour ───────────────────────────────────────────────────────────── */
  const empty = await runSearch(pool, parseSearchQuery("   ", "2026-03-31"), 10);
  record("boş sorgu VERİ DÖKÜMÜ döndürmüyor",
    empty.hits.length === 0 && empty.searchedEntities.length === 0,
    "önünde arama kutusu olan bir veri dökümü, arama sonucu değildir");
  const grouped = groupHits(ownerHits.hits);
  record("sonuçlar entity'ye göre gruplanıyor",
    grouped.every((g) => g.hits.length > 0), `${grouped.length} grup`);
  const twice = await runSearch(pool, intent, 20);
  record("aynı sorgu iki kez AYNI sırayı veriyor (toplam düzen)",
    JSON.stringify(twice.hits.map((h) => h.id)) === JSON.stringify(ownerHits.hits.map((h) => h.id)),
    "tarih, entity, id ile sıralanıyor");

  /* ── 11. house rules ────────────────────────────────────────────────────────────────── */
  const matrixSrc = readSrc("src/lib/authz/matrix.ts");
  record("documents/attachments/document_links Faz 24B'de sınıflandırıldı",
    /documents:\s*"operational"/.test(matrixSrc)
      && /attachments:\s*"evidence"/.test(matrixSrc)
      && /document_links:\s*"operational"/.test(matrixSrc),
    "attachments EVIDENCE — append-only, hiçbir katman update/delete edemez");
  const rls = await pool.query(`
    select relname, relrowsecurity from pg_class
    where oid in ('public.documents'::regclass,'public.attachments'::regclass,'public.document_links'::regclass)`);
  record("üç tabloda da RLS açık",
    rls.rows.every((r) => r.relrowsecurity === true), rls.rows.map((r) => r.relname).join(", "));
  const attachPolicies = await pool.query(`
    select cmd from pg_policies where schemaname='public' and tablename='attachments'`);
  record("attachments'ta UPDATE/DELETE policy'si YOK",
    !attachPolicies.rows.some((r) => ["UPDATE", "DELETE"].includes(String(r.cmd))),
    attachPolicies.rows.map((r) => r.cmd).join(", "));
  const FLOAT_CAST = new RegExp("::" + "float8");
  const newSources = ["src/lib/search/registry.ts", "src/lib/search/nl.ts",
    "src/lib/search/engine.ts", "src/lib/documents/storage.ts", "src/lib/documents/engine.ts",
    "supabase/migrations/0083_documents.sql"];
  const floaty = newSources.filter((f) => FLOAT_CAST.test(codeOnly(readSrc(f))));
  record("yeni kaynakların hiçbirinde float8 cast'i yok", floaty.length === 0,
    floaty.join(", ") || `${newSources.length} dosya temiz`);
  record("doküman motoru audit() ve Zod sınırı taşıyor",
    /audit\(/.test(codeOnly(readSrc("src/lib/documents/engine.ts")))
      && /createDocumentSchema\s*=\s*z\.object/.test(readSrc("src/lib/documents/engine.ts")), "");
  const migrateSrc = readSrc("scripts/db/migrate.ts");
  record("ANCHORS'a dokunulmadı",
    !migrateSrc.slice(migrateSrc.indexOf("const ANCHORS")).slice(0, 4000).includes("0083"),
    "yalnız 0001-0019 legacy tespiti için");

  await purge();

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length) {
    console.log(`PHASE35 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE35 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error(messageOf(e));
  await purge();
  await pool.end().catch(() => undefined);
  process.exit(1);
});
