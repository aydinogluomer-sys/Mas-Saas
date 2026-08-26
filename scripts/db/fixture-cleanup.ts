// AŞAMA 14 / P0-DRIFT-01 — gerçek DB'deki doğrulama fixture'larını temizler.
//
// BU SCRIPT GERÇEK VERİTABANINA YAZAR. Rehber §29 gereği bu, `mas_radar_dev` üzerinde
// izin verilen dar istisnalardan biridir ve YALNIZ kullanıcının açık kararıyla koşar.
//
// KULLANICININ VERDİĞİ SIRA (2026-08-26) SCRIPT'İN İÇİNE GÖMÜLDÜ:
//   off-device backup → destination SHA256 → pg_restore listability → receipt
//   → fixture cleanup → post-cleanup fingerprint
// Kapı, gerçek `offdevice-copy.ts` kaydını okur ve dört koşulun DÖRDÜNÜ birden arar.
// Bayrakla atlanamaz.
//
// ÜÇ SAVUNMA KATMANI, hepsi COMMIT'ten ÖNCE:
//   1. Off-device kapısı — doğrulanmış ayrı-aygıt yedeği yoksa hiç başlamaz.
//   2. FK kataloğu — silinecek tablolara gelen yabancı anahtarlar ve ON DELETE davranışları
//      pg_catalog'dan çıkarılır; beklenmeyen bir CASCADE varsa DURDURULUR.
//   3. Tam parmak izi — izin verilen delta dışında tek bir satır/hash değişirse ROLLBACK.
//
// SİLİNECEK KAYITLAR — sabit liste, kalıp (LIKE) DEĞİL:
//   users:             p24b_fixture_a, p24b_fixture_b, p24b_mk_mujyy6, p24b_op_9bcmx5
//   payments:          7b300bfe-944f-468b-91fa-2de65b7cfee5  ("P24B fixture", 1000.00 TL)
//   payment_instances: yukarıdaki ödemenin 3 taksiti
import { Pool } from "pg";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requireOwnerDatabaseUrl, databaseNameFromUrl } from "./owner-url";
import { offDeviceCleanupBlockers, type OffDeviceCopyRecord } from "../ops/backup-lib";
import { fingerprint, type Fingerprint } from "../release/lib/fingerprint";

const EXPECTED_DB = "mas_radar_dev";

const FIXTURE_USERNAMES = Object.freeze([
  "p24b_fixture_a", "p24b_fixture_b", "p24b_mk_mujyy6", "p24b_op_9bcmx5",
]);
const FIXTURE_PAYMENT_ID = "7b300bfe-944f-468b-91fa-2de65b7cfee5";

/** İzin verilen TEK veri deltası. Başka her değişiklik FAIL. */
const ALLOWED_DELTA: Readonly<Record<string, number>> = Object.freeze({
  users: -4,
  payments: -1,
  payment_instances: -3,
});

/**
 * ŞEMA SÖZLEŞMESİ — canlı şemadan ÖLÇÜLDÜ, varsayılmadı.
 *
 * İlk sürüm `payment_instances.payment_id`'nin CASCADE olduğunu VARSAYMIŞTI. Canlı şemadan
 * çıkarılan gerçek şudur:
 *
 *   payment_instances.payment_id → payments   ON DELETE SET NULL   (CASCADE DEĞİL)
 *   users'a gelen 41 FK'nın hepsi              ON DELETE NO ACTION
 *   payment_instances'a gelen FK                yok
 *
 * SET NULL, bu iş için CASCADE'den DAHA tehlikelidir: ödeme, taksitleri silinmeden
 * kaldırılsaydı üç taksit `payment_id = NULL` ile HAYATTA KALIR ve sahipsiz hayalet borç
 * olarak ödeme radarında görünmeye devam ederdi. Script bu yüzden taksitleri ÖNCE siler.
 *
 * Aşağıdaki harita bir izin listesi değil, bir SÖZLEŞMEDİR: canlı şema bundan saparsa
 * (yeni migration bir FK'yı CASCADE'e çevirmiş olabilir) script durur, çünkü silmenin ne
 * sürükleyeceği artık bilinmiyor.
 */
const FK_CONTRACT: Readonly<Record<string, string>> = Object.freeze({
  "payment_instances.payment_id": "SET NULL",
});
/** Sözleşmede adı geçmeyen her çocuk için beklenen davranış. */
const FK_CONTRACT_DEFAULT = "NO ACTION";

interface InboundFk {
  child: string; childCol: string; parent: string; onDelete: string; constraint: string;
}

async function inboundForeignKeys(c: Queryable, parents: string[]): Promise<InboundFk[]> {
  const r = await c.query(
    `select con.conname as constraint,
            cl.relname  as child,
            att.attname as child_col,
            pcl.relname as parent,
            case con.confdeltype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
                 when 'c' then 'CASCADE' when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT'
                 else con.confdeltype::text end as on_delete
       from pg_constraint con
       join pg_class cl   on cl.oid  = con.conrelid
       join pg_class pcl  on pcl.oid = con.confrelid
       join pg_namespace n on n.oid  = cl.relnamespace
       join unnest(con.conkey) with ordinality as k(attnum, ord) on true
       join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
      where con.contype = 'f' and n.nspname = 'public' and pcl.relname = any($1::text[])
      order by cl.relname, att.attname`,
    [parents],
  );
  return r.rows.map((x: Record<string, string>) => ({
    child: x.child, childCol: x.child_col, parent: x.parent,
    onDelete: x.on_delete, constraint: x.constraint,
  }));
}

interface Queryable { query: (q: string, v?: unknown[]) => Promise<{ rows: Array<Record<string, string>>; rowCount: number | null }> }

/**
 * Off-device kapısı. Gerçek `offdevice-copy.ts` kaydının ALAN ADLARINI kullanır — bu tanım
 * `scripts/ops/backup-lib.ts` içinde TEK yerde yaşar, böylece iki script'in alan adları
 * bir daha sessizce ayrışamaz.
 */
function assertOffDeviceProof(): OffDeviceCopyRecord {
  const p = process.env.MAS_FIXTURE_CLEANUP_RECEIPT;
  if (!p || p.trim() === "") {
    throw new Error(
      "DURDURULDU: off-device yedek kaydı verilmedi.\n" +
        "Sıra: off-device backup → destination SHA256 → pg_restore listability → receipt → cleanup.\n" +
        "Önce `pnpm ops:backup:offdevice` koşun, sonra üretilen `<dump>.offdevice.json` yolunu\n" +
        "MAS_FIXTURE_CLEANUP_RECEIPT ile verin.",
    );
  }
  if (!existsSync(p)) throw new Error(`DURDURULDU: kayıt dosyası bulunamadı: ${p}`);
  const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
  const blockers = offDeviceCleanupBlockers(raw);
  if (blockers.length > 0) {
    throw new Error(
      "DURDURULDU: off-device kaydı yıkıcı işlem için YETMİYOR:\n" +
        blockers.map((b) => "  - " + b).join("\n"),
    );
  }
  return raw as OffDeviceCopyRecord;
}

function diffFingerprints(before: Fingerprint, after: Fingerprint): string[] {
  const problems: string[] = [];
  const tables = new Set([...Object.keys(before.counts), ...Object.keys(after.counts)]);
  for (const t of tables) {
    const b = before.counts[t], a = after.counts[t];
    if (b === undefined || a === undefined) { problems.push(`tablo kümesi değişti: ${t}`); continue; }
    const want = ALLOWED_DELTA[t] ?? 0;
    if (a - b !== want) problems.push(`${t}: delta ${want} bekleniyordu, ${a - b} oldu (${b} → ${a})`);
  }
  // Satır hash'leri: delta beklenen tablolarda değişmesi NORMAL, diğer HER tabloda değişmesi FAIL.
  for (const t of Object.keys(before.hashes)) {
    if (t in ALLOWED_DELTA) continue;
    if (before.hashes[t] !== after.hashes[t]) problems.push(`${t}: satır hash'i DEĞİŞTİ (izin verilen delta dışında)`);
  }
  // Parasal toplamlar: yalnız fixture'ın taşıdığı iki tanesi değişebilir.
  const mayChange = new Set(["payments.default_amount", "payment_instances.amount"]);
  for (const k of Object.keys(before.aggregates)) {
    if (mayChange.has(k)) continue;
    if (before.aggregates[k] !== after.aggregates[k]) {
      problems.push(`${k}: '${before.aggregates[k]}' → '${after.aggregates[k]}' DEĞİŞTİ`);
    }
  }
  if (before.ledger.latest !== after.ledger.latest || before.ledger.rows !== after.ledger.rows) {
    problems.push(`ledger değişti: ${before.ledger.rows}/${before.ledger.latest} → ${after.ledger.rows}/${after.ledger.latest}`);
  }
  return problems;
}

async function main(): Promise<void> {
  const url = requireOwnerDatabaseUrl();
  const dbName = databaseNameFromUrl(url);
  if (dbName !== EXPECTED_DB) {
    throw new Error(`DURDURULDU: bu script yalnız '${EXPECTED_DB}' üzerinde koşar; hedef '${dbName ?? "?"}'.`);
  }

  const proof = assertOffDeviceProof();
  console.log("── 1/4 off-device kapısı ───────────────────────────────────────────");
  console.log(`PASS  kayıt kabul edildi: ${path.basename(proof.destPath)}.offdevice.json`);
  console.log(`      targetKind=${proof.targetKind} · sha256@dest=OK · bytes@dest=OK · pg_restore --list=OK`);
  console.log(`      sha256=${proof.destSha256.slice(0, 16)}…  TOC=${proof.destTocEntryCount ?? "?"}`);
  console.log(`\nHedef: db=${dbName}\n`);

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  const failures: string[] = [];
  let committed = false;
  let before: Fingerprint | null = null;
  let after: Fingerprint | null = null;
  let fks: InboundFk[] = [];

  try {
    console.log("── 2/4 yabancı anahtar kataloğu (beklenmeyen CASCADE var mı) ───────");
    const q = client as unknown as Queryable;
    fks = await inboundForeignKeys(q, ["users", "payments", "payment_instances"]);
    for (const fk of fks) {
      const key = `${fk.child}.${fk.childCol}`;
      const want = FK_CONTRACT[key] ?? FK_CONTRACT_DEFAULT;
      const bad = fk.onDelete !== want;
      console.log(`  ${bad ? "DURDUR" : "  ok  "} ${key.padEnd(42)} → ${fk.parent.padEnd(18)} ON DELETE ${fk.onDelete}`);
      if (bad) {
        failures.push(
          `FK sözleşmesi ihlali: ${key} → ${fk.parent} ON DELETE ${fk.onDelete}, '${want}' bekleniyordu (${fk.constraint})`,
        );
      }
    }
    console.log(`  ${fks.length} gelen FK incelendi\n`);
    if (failures.length > 0) {
      console.error("DURDURULDU — beklenmeyen CASCADE. Hiçbir satır silinmedi:");
      for (const f of failures) console.error("  - " + f);
      process.exitCode = 1;
      return;
    }

    console.log("── 3/4 silme (transaction içinde, doğrulanmadan COMMIT yok) ────────");
    before = await fingerprint(q as never);
    await client.query("begin");

    const delInst = await client.query("delete from public.payment_instances where payment_id = $1", [FIXTURE_PAYMENT_ID]);
    const delPay = await client.query("delete from public.payments where id = $1", [FIXTURE_PAYMENT_ID]);
    const delUsers = await client.query("delete from public.users where username = any($1::text[])", [FIXTURE_USERNAMES]);
    console.log(`  silinen: payment_instances=${delInst.rowCount} payments=${delPay.rowCount} users=${delUsers.rowCount}`);

    if (delInst.rowCount !== 3) failures.push(`payment_instances silme 3 bekleniyordu, ${delInst.rowCount} oldu`);
    if (delPay.rowCount !== 1) failures.push(`payments silme 1 bekleniyordu, ${delPay.rowCount} oldu`);
    if (delUsers.rowCount !== 4) failures.push(`users silme 4 bekleniyordu, ${delUsers.rowCount} oldu`);

    console.log("\n── 4/4 TAM parmak izi karşılaştırması (COMMIT'ten ÖNCE) ────────────");
    after = await fingerprint(q as never, before.columns);
    failures.push(...diffFingerprints(before, after));

    const atilla = await client.query("select count(*)::text as n from public.users where username = 'atilla'");
    if (atilla.rows[0].n !== "1") failures.push(`'atilla' hesabı kayboldu (count=${atilla.rows[0].n})`);
    const leftover = await client.query("select count(*)::text as n from public.users where username like 'p24b%'");
    if (leftover.rows[0].n !== "0") failures.push(`p24b kalıntısı var (count=${leftover.rows[0].n})`);

    const changed = Object.keys(before.counts).filter((t) => before!.counts[t] !== after!.counts[t]);
    console.log(`  değişen tablo: ${changed.length === 0 ? "yok" : changed.map((t) => `${t} ${before!.counts[t]}→${after!.counts[t]}`).join(" · ")}`);
    console.log(`  hash değişen tablo: ${Object.keys(before.hashes).filter((t) => before!.hashes[t] !== after!.hashes[t]).join(" · ") || "yok"}`);

    if (failures.length > 0) {
      await client.query("rollback");
      console.error("\nROLLBACK — hiçbir satır silinmedi. Nedenler:");
      for (const f of failures) console.error("  - " + f);
      process.exitCode = 1;
      return;
    }

    await client.query("commit");
    committed = true;
    console.log("\nFIXTURE CLEANUP: COMMIT edildi.");
  } catch (err) {
    try { await client.query("rollback"); } catch { /* bağlantı zaten kopmuş olabilir */ }
    throw err;
  } finally {
    client.release();
    await pool.end();
    if (before !== null && after !== null) {
      const b: Fingerprint = before, a: Fingerprint = after;
      const out = process.env.MAS_FIXTURE_CLEANUP_OUT
        ?? "docs/release-evidence/final-production-readiness/12-fixture-cleanup.md";
      const countRows = Object.keys(b.counts)
        .filter((t) => b.counts[t] !== a.counts[t] || t in ALLOWED_DELTA)
        .map((t) => `| ${t} | ${b.counts[t]} | ${a.counts[t]} | ${ALLOWED_DELTA[t] ?? 0} |`).join("\n");
      const aggRows = Object.keys(b.aggregates)
        .map((k) => `| ${k} | ${b.aggregates[k]} | ${a.aggregates[k]} |`).join("\n");
      const fkRows = fks.map((f) => `| ${f.child}.${f.childCol} | ${f.parent} | ${f.onDelete} |`).join("\n");
      writeFileSync(out,
        `# 12 — Fixture temizliği (P0-DRIFT-01)\n\n` +
        "```text\n" +
        `TARGET DATABASE CLASS: PRODUCTION_WRITE\nTARGET DATABASE NAME: ${dbName}\n` +
        `REAL DB WRITE USED: YES — kullanıcının 2026-08-26 tarihli açık kararıyla\n` +
        `SONUÇ: ${committed ? "COMMIT" : "ROLLBACK — hiçbir satır silinmedi"}\n` +
        "```\n\n" +
        `## Off-device ön koşulu\n\n| alan | değer |\n|---|---|\n` +
        `| targetKind | ${proof.targetKind} |\n| offDeviceSatisfied | ${proof.offDeviceSatisfied} |\n` +
        `| sha256VerifiedAtDestination | ${proof.sha256VerifiedAtDestination} |\n` +
        `| bytesVerifiedAtDestination | ${proof.bytesVerifiedAtDestination} |\n` +
        `| destRestoreListable | ${proof.destRestoreListable} (TOC ${proof.destTocEntryCount ?? "?"}) |\n` +
        `| destSha256 | ${proof.destSha256} |\n\n` +
        `## Gelen yabancı anahtarlar (${fks.length})\n\n| çocuk | ebeveyn | ON DELETE |\n|---|---|---|\n${fkRows}\n\n` +
        `## Satır sayıları\n\n| tablo | önce | sonra | izinli delta |\n|---|---:|---:|---:|\n${countRows}\n\n` +
        `## Parasal toplamlar\n\n| ölçüt | önce | sonra |\n|---|---:|---:|\n${aggRows}\n\n` +
        (failures.length ? `## Başarısızlıklar\n\n${failures.map((f) => "- " + f).join("\n")}\n\n` : "") +
        `**FINAL: ${committed ? "PASS" : "ROLLBACK"}**\n`,
        "utf8");
      console.log(`Kanıt: ${out}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
