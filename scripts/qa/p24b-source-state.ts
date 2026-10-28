// P24B — kaynak veritabanının SALT OKUNUR durum ölçümü.
//
// NEDEN VAR. Cleanup'ın bağlanacağı state, yedeğin alındığı andaki state ile aynı olmak
// zorunda. Docker/Postgres kapanıp yeniden açıldığında "nasılsa değişmemiştir" demek bir
// ölçüm değildir; bu script o anki gerçeği tek bir artifact olarak yazar ve sonraki turlar
// onunla karşılaştırır.
//
// KENDİ HESABI YOK. Parmak izlerini `p24b-cleanup-fingerprint.ts`'teki KANONİK yardımcılar
// üretir — cleanup, binding ve restore smoke ile aynı fonksiyonlar. İkinci bir uygulama,
// iki cevabın sessizce ayrışmasının yoludur.
//
// READ-ONLY MOTOR TARAFINDAN ZORLANIR (quiescence-snapshot.ts ile aynı üç katman):
//   1. bağlantı `default_transaction_read_only=on` ile açılır,
//   2. her ifade açık bir `BEGIN READ ONLY` içinde koşar,
//   3. transaction HER ZAMAN ROLLBACK ile kapanır — asla COMMIT.
// Sunucunun kendi `show transaction_read_only` cevabı artifact'a yazılır: zararsızlığın
// kanıtı niyet değil ölçüm olsun diye.
//
// BAĞLANTI DİZESİ ASLA BASILMAZ/SERİLEŞTİRİLMEZ — parola taşır. Yalnız veritabanı ADI çıkar.
//
// Kullanım: node --import tsx scripts/qa/p24b-source-state.ts <out.json> [etiket]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { ownerDatabaseUrl, databaseNameFromUrl } from "../db/owner-url";
import {
  targetFingerprint, wholeDbFingerprintDigest, tableSetKey, type BaseTableRef,
} from "../db/p24b-cleanup-fingerprint";

const MANIFEST_PATH = path.join(
  "docs", "release-evidence", "final-production-readiness", "p24b-v6", "02-row-evidence-manifest.json",
);
const TABLES = ["action_items", "approvals", "payment_instances", "payments", "users", "settings"] as const;

interface ManifestRow { table: string; id: string; classification: string }
interface Manifest { rows: ManifestRow[] }

function die(m: string): never { console.error(`DURDURULDU: ${m}`); process.exit(1); }

async function main(): Promise<void> {
  const out = process.argv[2];
  const label = process.argv[3] ?? "source-state";
  if (!out) die("kullanım: p24b-source-state.ts <out.json> [etiket]");

  const url = ownerDatabaseUrl();
  if (!url) die("MIGRATION_DATABASE_URL tanımlı değil");
  const dbFromUrl = databaseNameFromUrl(url);

  const manifestRaw = readFileSync(MANIFEST_PATH);
  const manifestSha256 = createHash("sha256").update(manifestRaw).digest("hex");
  const targets = (JSON.parse(manifestRaw.toString("utf8")) as Manifest).rows
    .filter((r) => r.classification === "DELETE_TARGET");

  const pool = new Pool({ connectionString: url, max: 1, options: "-c default_transaction_read_only=on" });
  const c = await pool.connect();
  try {
    await c.query("begin read only");
    // 3. katmanın kanıtı: NE İSTEDİĞİMİZ değil, sunucunun NE DEDİĞİ. `show` takma ad kabul
    // etmez — sütun adı ayarın kendisidir; `... as v` yazmak sessizce undefined üretir.
    const transactionReadOnly = (await c.query<{ transaction_read_only: string }>(
      "show transaction_read_only")).rows[0].transaction_read_only;
    const database = (await c.query<{ d: string }>("select current_database() d")).rows[0].d;
    if (dbFromUrl !== undefined && database !== dbFromUrl) {
      die(`bağlantı kimliği URL ile ayrışıyor: URL '${dbFromUrl}', sunucu '${database}'`);
    }

    const led = (await c.query<{ v: string; n: string }>(
      "select max(version) v, count(*)::text n from public.schema_migrations")).rows[0];

    const baseTables: BaseTableRef[] = (await c.query<BaseTableRef>(
      `select table_schema as schema, table_name as name
         from information_schema.tables
        where table_type = 'BASE TABLE' and table_schema = any($1::text[])
        order by table_schema, table_name`, [["public", "auth"]])).rows;

    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      counts[t] = Number((await c.query<{ n: string }>(`select count(*)::text n from public.${t}`)).rows[0].n);
    }

    const target = await targetFingerprint(c, targets);
    const wholeDbFingerprint = await wholeDbFingerprintDigest(c);

    const state = {
      stateKind: "mas-p24b-source-state-v1",
      label,
      measuredAtUtc: new Date().toISOString(),
      database,
      transactionReadOnly,
      manifestSha256,
      ledger: `${led.v}/${led.n}`,
      migrationLatest: led.v,
      migrationCount: Number(led.n),
      baseTableCount: baseTables.length,
      baseTableSetKey: tableSetKey(baseTables),
      counts,
      targetExpected: target.expected,
      targetFound: target.found,
      targetMissing: target.missing,
      targetFingerprint: target.digest,
      wholeDbFingerprint,
    };
    writeFileSync(out, JSON.stringify(state, null, 2) + "\n", "utf8");

    console.log(`DATABASE              : ${state.database}`);
    console.log(`transaction_read_only : ${state.transactionReadOnly}   (sunucunun kendi cevabı)`);
    console.log(`LEDGER                : ${state.ledger}`);
    console.log(`BASE_TABLE_COUNT      : ${state.baseTableCount}`);
    console.log(`TARGET_EXPECTED       : ${state.targetExpected}`);
    console.log(`TARGET_FOUND          : ${state.targetFound}`);
    console.log(`TARGET_MISSING        : ${state.targetMissing.length}`);
    for (const t of TABLES) console.log(`  ${t.padEnd(20)}: ${state.counts[t]}`);
    console.log(`TARGET_FINGERPRINT    : ${state.targetFingerprint}`);
    console.log(`WHOLE_DB_FINGERPRINT  : ${state.wholeDbFingerprint}`);
    console.log(`yazıldı: ${out}`);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
