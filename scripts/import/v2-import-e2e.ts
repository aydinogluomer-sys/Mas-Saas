// Standart Import V2 — uçtan uca import kanıtı (§40, §41, §42).
//
// NE KANITLAR:
//   1. Fixture workbook gerçek bir veritabanına yazılır ve sayımlar oracle ile tutar.
//   2. AYNI dosya ikinci kez yüklendiğinde MÜKERRER OLUŞMAZ — kayıtlar güncellenir (§27).
//   3. Reddedilmiş satırlar domain'e HİÇ yazılmaz ama hazırlık katmanında ham hâliyle DURUR.
//   4. Yazılan her domain kaydı kaynak satırına geri izlenebilir (§26).
//   5. Eşleyicisi olmayan aileler sessizce kaybolmaz; adıyla raporlanır.
//
// GÜVENLİK: yalnız harcanabilir bir veritabanına karşı çalışır. Hedef adı `verify`, `test`,
// `clone` gibi bir işaret taşımıyorsa ya da korunan listedeyse hiç bağlanmadan durur.
import { Pool } from "pg";
import { buildFixtureWorkbook, FIXTURE_ORACLE } from "../../src/lib/importers/v2/fixture";
import { parseWorkbook } from "../../src/lib/importers/v2/parser";
import { mapWorkbook, FAMILY_WRITERS } from "../../src/lib/importers/v2/mapper";
import { requireDisposableOwnerDatabaseUrl } from "../db/owner-url";

interface Check { ad: string; beklenen: unknown; gelen: unknown; gecti: boolean }
const checks: Check[] = [];

function assert(ad: string, beklenen: unknown, gelen: unknown): void {
  const gecti = JSON.stringify(beklenen) === JSON.stringify(gelen);
  checks.push({ ad, beklenen, gelen, gecti });
  console.log(`${gecti ? "GEÇTİ " : "DÜŞTÜ "} ${ad}${gecti ? "" : `\n         beklenen: ${JSON.stringify(beklenen)}\n         gelen   : ${JSON.stringify(gelen)}`}`);
}

const TABLES_TO_RESET = [
  "import_external_keys", "mapping_reviews", "import_rows", "source_cells",
  "source_sheets", "payments", "checks", "loans", "source_workbooks",
];

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireDisposableOwnerDatabaseUrl("V2 import E2E") });
  const client = await pool.connect();

  try {
    const db = (await client.query<{ d: string }>("select current_database() as d")).rows[0].d;
    console.log(`Hedef (harcanabilir): ${db}\n`);

    // Temiz başlangıç. `cascade` yalnız harcanabilir hedefte kabul edilebilir bir araçtır.
    await client.query(`truncate ${TABLES_TO_RESET.map((t) => `public.${t}`).join(", ")} cascade`);
    await client.query("truncate public.parties, public.categories cascade");

    // Aktör. Bu bir KİMLİK BİLGİSİ DEĞİL: password_hash kasten geçersiz bir işaret; bu
    // kullanıcıyla giriş yapılamaz, yalnız audit ve imported_by alanları dolsun diye var.
    const actor = (await client.query<{ id: string }>(
      `insert into public.users (username, password_hash, display_name, role)
       values ('v2-e2e-fixture', 'DISABLED-NOT-A-CREDENTIAL', 'V2 E2E fixture aktörü', 'admin')
       on conflict (username) do update set display_name = excluded.display_name
       returning id`,
    )).rows[0].id;

    const wb = await buildFixtureWorkbook();
    const parsed = parseWorkbook(wb);

    /* ── 1. geçiş ─────────────────────────────────────────────────────────────────────── */
    console.log("── 1. IMPORT ──");
    await client.query("begin");
    const first = await mapWorkbook(client, parsed, {
      filename: "fixture-v2.xlsx", fileSha256: null, actorId: actor,
    });
    await client.query("commit");

    assert("hazırlığa yazılan satır = oracle rowsRead", FIXTURE_ORACLE.totals.rowsRead, first.rowsStaged);
    assert("reddedilen satır = oracle rejected", FIXTURE_ORACLE.totals.rejected, first.rowsRejected);
    assert("incelemeye düşen satır = oracle needsReview", FIXTURE_ORACLE.totals.needsReview, first.rowsNeedsReview);

    const staged = Number((await client.query<{ c: string }>("select count(*) c from public.import_rows")).rows[0].c);
    assert("import_rows satır sayısı = hazırlığa yazılan", first.rowsStaged, staged);

    const emptyRaw = Number((await client.query<{ c: string }>(
      "select count(*) c from public.import_rows where row_json = '{}'::jsonb",
    )).rows[0].c);
    assert("HİÇBİR satır boş ham veriyle yazılmadı", 0, emptyRaw);

    const rejectedStaged = Number((await client.query<{ c: string }>(
      "select count(*) c from public.import_rows where mapping_status = 'rejected'",
    )).rows[0].c);
    assert("reddedilen satırlar hazırlıkta DURUYOR", FIXTURE_ORACLE.totals.rejected, rejectedStaged);

    const rejectedMapped = Number((await client.query<{ c: string }>(
      "select count(*) c from public.import_rows where mapping_status = 'rejected' and mapped_entity_id is not null",
    )).rows[0].c);
    assert("reddedilen hiçbir satır domain'e yazılmadı", 0, rejectedMapped);

    // Yazıcısı olan üç aile.
    const counts = async (): Promise<Record<string, number>> => ({
      payments: Number((await client.query<{ c: string }>("select count(*) c from public.payments")).rows[0].c),
      checks: Number((await client.query<{ c: string }>("select count(*) c from public.checks")).rows[0].c),
      loans: Number((await client.query<{ c: string }>("select count(*) c from public.loans")).rows[0].c),
    });
    const after1 = await counts();
    console.log(`   domain: payments=${after1.payments} checks=${after1.checks} loans=${after1.loans}`);
    console.log(`   perTable: ${JSON.stringify(first.perTable)}`);
    console.log(`   yalnız hazırlıkta kalan aileler: ${first.stagedOnlyFamilies.join(", ") || "(yok)"}`);
    console.log(`   yalnız hazırlıkta kalan satır: ${first.rowsStagedOnly}`);

    assert("yazıcısı olan aile sayısı", Object.keys(FAMILY_WRITERS).length, Object.keys(first.perTable).length);

    // Yazılan kayıt sayısı, o sayfanın "hazır" satır sayısına EŞİT olmalı. Az olsaydı sessiz
    // veri kaybı, çok olsaydı uydurma kayıt demekti.
    const READY = FIXTURE_ORACLE.sheets as Record<string, { ready: number }>;
    assert("payments = 01_ODEMELER hazır satır sayısı", READY["01_ODEMELER"].ready, after1.payments);
    assert("checks = 02_CEKLER hazır satır sayısı", READY["02_CEKLER"].ready, after1.checks);
    assert("loans = 03_KREDILER hazır satır sayısı", READY["03_KREDILER"].ready, after1.loans);

    const keyCount1 = Number((await client.query<{ c: string }>(
      "select count(*) c from public.import_external_keys",
    )).rows[0].c);

    // §26 — her domain kaydı kaynak satırına bağlı.
    for (const t of ["payments", "checks"]) {
      const orphan = Number((await client.query<{ c: string }>(
        `select count(*) c from public.${t} where source_row_id is null`,
      )).rows[0].c);
      assert(`${t}: kaynak satırı olmayan kayıt yok (§26)`, 0, orphan);
    }
    const loanOrphan = Number((await client.query<{ c: string }>(
      "select count(*) c from public.loans where source_sheet_id is null",
    )).rows[0].c);
    assert("loans: kaynak sayfası olmayan kayıt yok (§26)", 0, loanOrphan);

    /* ── 2. geçiş — AYNI dosya ────────────────────────────────────────────────────────── */
    console.log("\n── 2. IMPORT (aynı dosya) ──");
    await client.query("begin");
    const second = await mapWorkbook(client, parsed, {
      filename: "fixture-v2.xlsx", fileSha256: null, actorId: actor,
    });
    await client.query("commit");

    const after2 = await counts();
    console.log(`   domain: payments=${after2.payments} checks=${after2.checks} loans=${after2.loans}`);
    console.log(`   perTable: ${JSON.stringify(second.perTable)}`);

    assert("İKİNCİ IMPORT MÜKERRER ÜRETMEDİ (payments)", after1.payments, after2.payments);
    assert("İKİNCİ IMPORT MÜKERRER ÜRETMEDİ (checks)", after1.checks, after2.checks);
    assert("İKİNCİ IMPORT MÜKERRER ÜRETMEDİ (loans)", after1.loans, after2.loans);

    const insertedAgain = Object.values(second.perTable).reduce((n, t) => n + t.inserted, 0);
    const updatedAgain = Object.values(second.perTable).reduce((n, t) => n + t.updated, 0);
    assert("ikinci geçişte hiçbir kayıt YARATILMADI", 0, insertedAgain);
    console.log(`   güncellenen kayıt: ${updatedAgain}`);
    if (updatedAgain === 0) {
      checks.push({ ad: "ikinci geçişte kayıtlar güncellendi", beklenen: ">0", gelen: 0, gecti: false });
      console.log("DÜŞTÜ  ikinci geçişte hiçbir kayıt güncellenmedi — defter çalışmıyor olabilir");
    }

    // Hazırlık katmanı BİRİKİR: ikinci dosya ikinci bir iz kaydıdır, bu doğru davranıştır.
    const staged2 = Number((await client.query<{ c: string }>("select count(*) c from public.import_rows")).rows[0].c);
    assert("hazırlık katmanı her import'u ayrı saklar", first.rowsStaged * 2, staged2);

    const keyCount2 = Number((await client.query<{ c: string }>(
      "select count(*) c from public.import_external_keys",
    )).rows[0].c);
    console.log(`   external_id defteri: 1. geçiş ${keyCount1} → 2. geçiş ${keyCount2}`);
    assert("defter ikinci import'ta BÜYÜMEDİ", keyCount1, keyCount2);

    /* ── Özet ─────────────────────────────────────────────────────────────────────────── */
    const failed = checks.filter((c) => !c.gecti);
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Kontrol: ${checks.length} · geçti: ${checks.length - failed.length} · düştü: ${failed.length}`);
    console.log(JSON.stringify({
      db, firstPass: first, secondPass: second,
      domainAfterFirst: after1, domainAfterSecond: after2,
      externalKeys: { afterFirst: keyCount1, afterSecond: keyCount2 },
      checks: checks.map((c) => ({ ad: c.ad, gecti: c.gecti })),
    }, null, 2));

    if (failed.length > 0) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
