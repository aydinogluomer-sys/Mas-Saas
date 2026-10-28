// Bir veritabanının TABLO BAZINDA parmak izini yazar — salt okunur.
//
// NEDEN VAR. "prepare-runtime hiçbir şeyi bozmadı" iddiası ancak öncesi ve sonrası tablo tablo
// karşılaştırılırsa kanıt olur. Toplam satır sayısı yetmez: bir satırın eklenip başka birinin
// silinmesi sayıyı değiştirmez. Bu yüzden her tablo için hem sayı hem içerik hash'i yazılır.
//
// KENDİ HESABI YOK: `wholeDbFingerprintMap` kanonik yardımcısını kullanır — cleanup, binding ve
// restore smoke ile aynı fonksiyon.
//
// READ-ONLY MOTOR TARAFINDAN ZORLANIR: startup option + BEGIN READ ONLY + her zaman ROLLBACK.
// Bağlantı dizesi asla basılmaz; yalnız veritabanı adı çıkar.
//
// Kullanım: node --env-file=.env.local --import tsx scripts/qa/db-table-fingerprints.ts <out.json> [etiket]
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { ownerDatabaseUrl } from "../db/owner-url";
import { wholeDbFingerprintMap, digestOfMap } from "../db/p24b-cleanup-fingerprint";

async function main(): Promise<void> {
  const out = process.argv[2];
  const label = process.argv[3] ?? "fingerprints";
  if (!out) { console.error("kullanım: db-table-fingerprints.ts <out.json> [etiket]"); process.exit(1); }

  const url = ownerDatabaseUrl();
  if (!url) { console.error("MIGRATION_DATABASE_URL tanımlı değil"); process.exit(1); }

  const pool = new Pool({ connectionString: url, max: 1, options: "-c default_transaction_read_only=on" });
  const c = await pool.connect();
  try {
    await c.query("begin read only");
    const database = (await c.query<{ d: string }>("select current_database() d")).rows[0].d;
    const map = await wholeDbFingerprintMap(c);
    const payload = {
      artifactKind: "mas-db-table-fingerprints-v1",
      label, database, measuredAtUtc: new Date().toISOString(),
      tableCount: Object.keys(map).length,
      wholeDbDigest: digestOfMap(map),
      tables: map,
    };
    writeFileSync(out, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.log(`${label}: ${database} · ${payload.tableCount} tablo · digest ${payload.wholeDbDigest.slice(0, 16)}…`);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
