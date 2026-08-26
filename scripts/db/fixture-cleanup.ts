// AŞAMA 14 / P0-DRIFT-01 — gerçek DB'deki doğrulama fixture'larını temizler.
//
// BU SCRIPT GERÇEK VERİTABANINA YAZAR. Rehber §29 gereği bu, `mas_radar_dev` üzerinde
// izin verilen dar istisnalardan biridir ve YALNIZ kullanıcının açık kararıyla koşar.
//
// KULLANICININ VERDİĞİ SIRA (2026-08-26) SCRIPT'İN İÇİNE GÖMÜLDÜ:
//   off-device backup → verify → fixture cleanup → post-cleanup fingerprint → ...
// Bu yüzden script, DOĞRULANMIŞ bir off-device yedek makbuzu görmeden çalışmayı REDDEDER.
// Bayrakla atlanamaz; atlatmanın tek yolu makbuzu gerçekten üretmektir.
//
// NEDEN TRANSACTION İÇİNDE VE NEDEN KENDİ KENDİNİ DOĞRULAR. Silme üç tabloya dokunur
// (payment_instances → payments → users). Beklenen satır sayıları COMMIT'ten ÖNCE, aynı
// transaction içinde kontrol edilir; bir tanesi bile tutmazsa ROLLBACK edilir ve hiçbir şey
// değişmez. "Sildim, sonra baktım" değil, "tutmuyorsa hiç silmedim".
//
// SİLİNECEK KAYITLAR — tam liste, genişletilemez:
//   users:             p24b_fixture_a, p24b_fixture_b, p24b_mk_mujyy6, p24b_op_9bcmx5
//   payments:          7b300bfe-944f-468b-91fa-2de65b7cfee5  ("P24B fixture", 1000.00 TL)
//   payment_instances: yukarıdaki ödemenin 3 taksiti (2026-07-15 / 08-15 / 09-15, 1000.00 TL)
//
// `atilla` ve diğer HİÇBİR kayıt bu script tarafından görülmez: silme cümleleri sabit
// kimlik listeleriyle yazılmıştır, kalıp (LIKE) ile değil.
import { Pool } from "pg";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requireOwnerDatabaseUrl, databaseNameFromUrl } from "./owner-url";

const EXPECTED_DB = "mas_radar_dev";

/** Silinecek kullanıcı adları — sabit liste, kalıp değil. */
const FIXTURE_USERNAMES = Object.freeze([
  "p24b_fixture_a", "p24b_fixture_b", "p24b_mk_mujyy6", "p24b_op_9bcmx5",
]);
/** Silinecek ödeme kimliği — tek kayıt. */
const FIXTURE_PAYMENT_ID = "7b300bfe-944f-468b-91fa-2de65b7cfee5";

/** COMMIT'ten önce tutması ZORUNLU olan sayılar. Biri tutmazsa ROLLBACK. */
const EXPECTED_AFTER = Object.freeze({
  payments: 19,
  users: 13,
  payment_instances: 485,
  checks: 7,
  loans: 1,
  cashflow_months: 35,
});
/** COMMIT'ten önce tutması ZORUNLU olan parasal toplamlar (metin karşılaştırması, float değil). */
const EXPECTED_AGGREGATES_AFTER = Object.freeze({
  "payments.default_amount": "540000.00",
  "payment_instances.amount": "14550000.00",
});

type Counts = Record<string, number>;
type Aggregates = Record<string, string>;

async function counts(c: { query: (q: string) => Promise<{ rows: Array<Record<string, string>> }> }): Promise<Counts> {
  const out: Counts = {};
  for (const t of ["payments", "users", "payment_instances", "checks", "loans", "cashflow_months"]) {
    const r = await c.query(`select count(*)::text as n from public.${t}`);
    out[t] = Number(r.rows[0].n);
  }
  return out;
}

async function aggregates(c: { query: (q: string) => Promise<{ rows: Array<Record<string, string | null>> }> }): Promise<Aggregates> {
  const out: Aggregates = {};
  const specs: Array<[string, string, string]> = [
    ["payments.default_amount", "payments", "default_amount"],
    ["payment_instances.amount", "payment_instances", "amount"],
    ["checks.amount", "checks", "amount"],
    ["loans.principal", "loans", "principal"],
    ["cashflow_months.closing_balance", "cashflow_months", "closing_balance"],
  ];
  for (const [label, table, col] of specs) {
    const r = await c.query(`select coalesce(sum(${col}),0)::text as s from public.${table}`);
    out[label] = r.rows[0].s ?? "0";
  }
  return out;
}

/**
 * Off-device yedek kapısı. Kullanıcının verdiği sıranın ilk halkası budur ve BURADA
 * zorlanır: doğrulanmış bir makbuz yoksa hiçbir satır silinmez.
 *
 * Makbuz `MAS_FIXTURE_CLEANUP_RECEIPT` ile verilir. Kabul için makbuzun off-device
 * doğrulamasının GERÇEKTEN geçmiş olması gerekir — yerel bir klasör üreten makbuz
 * `offDeviceSatisfied: false` taşır ve reddedilir.
 */
function assertOffDeviceProof(): { path: string; sha256: string; target: string } {
  const p = process.env.MAS_FIXTURE_CLEANUP_RECEIPT;
  if (!p || p.trim() === "") {
    throw new Error(
      "DURDURULDU: off-device yedek makbuzu verilmedi.\n" +
        "Kullanıcının belirlediği sıra: off-device backup → verify → fixture cleanup.\n" +
        "Önce `pnpm ops:backup:offdevice` ile doğrulanmış bir kopya üretin, sonra\n" +
        "MAS_FIXTURE_CLEANUP_RECEIPT=<makbuz.json yolu> ile bu script'i çağırın.",
    );
  }
  if (!existsSync(p)) throw new Error(`DURDURULDU: makbuz dosyası bulunamadı: ${p}`);
  const r = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  const ok = r.offDeviceSatisfied === true;
  const verified = r.targetSha256Verified === true || r.sha256Verified === true;
  if (!ok) {
    throw new Error(
      "DURDURULDU: makbuz off-device DOĞRULANMADI (offDeviceSatisfied != true).\n" +
        "Sabit diskteki bir klasör off-device sayılmaz (rehber §30.5). Harici disk/NAS bağlayın.",
    );
  }
  if (!verified) {
    throw new Error("DURDURULDU: makbuzda hedefte sha256 doğrulaması yok (targetSha256Verified != true).");
  }
  return {
    path: p,
    sha256: String(r.sha256 ?? r.sourceSha256 ?? "?"),
    target: String(r.targetDir ?? r.target ?? "?"),
  };
}

async function main(): Promise<void> {
  const url = requireOwnerDatabaseUrl();
  const dbName = databaseNameFromUrl(url);
  if (dbName !== EXPECTED_DB) {
    throw new Error(`DURDURULDU: bu script yalnız '${EXPECTED_DB}' üzerinde koşar; hedef '${dbName ?? "?"}'.`);
  }

  const proof = assertOffDeviceProof();
  console.log(`Off-device makbuz KABUL edildi: ${path.basename(proof.path)}`);
  console.log(`  hedef=${proof.target}  sha256=${proof.sha256.slice(0, 16)}…`);
  console.log(`Hedef: db=${dbName}\n`);

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  const failures: string[] = [];
  let committed = false;
  let before: { counts: Counts; agg: Aggregates } | null = null;
  let after: { counts: Counts; agg: Aggregates } | null = null;

  try {
    before = { counts: await counts(client), agg: await aggregates(client) };
    console.log("ÖNCE:", JSON.stringify(before.counts));

    await client.query("begin");

    const delInst = await client.query(
      "delete from public.payment_instances where payment_id = $1", [FIXTURE_PAYMENT_ID],
    );
    const delPay = await client.query(
      "delete from public.payments where id = $1", [FIXTURE_PAYMENT_ID],
    );
    const delUsers = await client.query(
      "delete from public.users where username = any($1::text[])", [FIXTURE_USERNAMES],
    );
    console.log(`silinen: payment_instances=${delInst.rowCount} payments=${delPay.rowCount} users=${delUsers.rowCount}`);

    if (delInst.rowCount !== 3) failures.push(`payment_instances silme 3 bekleniyordu, ${delInst.rowCount} oldu`);
    if (delPay.rowCount !== 1) failures.push(`payments silme 1 bekleniyordu, ${delPay.rowCount} oldu`);
    if (delUsers.rowCount !== 4) failures.push(`users silme 4 bekleniyordu, ${delUsers.rowCount} oldu`);

    after = { counts: await counts(client), agg: await aggregates(client) };
    for (const [t, want] of Object.entries(EXPECTED_AFTER)) {
      if (after.counts[t] !== want) failures.push(`${t}: ${want} bekleniyordu, ${after.counts[t]} oldu`);
    }
    for (const [k, want] of Object.entries(EXPECTED_AGGREGATES_AFTER)) {
      if (after.agg[k] !== want) failures.push(`${k}: '${want}' bekleniyordu, '${after.agg[k]}' oldu`);
    }
    // Dokunulmaması gereken parasal toplamlar ÖNCE ile birebir aynı kalmalı.
    for (const k of ["checks.amount", "loans.principal", "cashflow_months.closing_balance"]) {
      if (after.agg[k] !== before.agg[k]) failures.push(`${k} DEĞİŞTİ: '${before.agg[k]}' → '${after.agg[k]}'`);
    }
    // atilla ve diğer gerçek hesaplar duruyor mu (pozitif kontrol — "hiçbir şey yok" yeterli değil).
    const atilla = await client.query("select count(*)::text as n from public.users where username = 'atilla'");
    if (atilla.rows[0].n !== "1") failures.push(`'atilla' hesabı kayboldu (count=${atilla.rows[0].n})`);
    const leftover = await client.query("select count(*)::text as n from public.users where username like 'p24b%'");
    if (leftover.rows[0].n !== "0") failures.push(`p24b kalıntısı var (count=${leftover.rows[0].n})`);

    if (failures.length > 0) {
      await client.query("rollback");
      console.error("\nROLLBACK — hiçbir satır silinmedi. Nedenler:");
      for (const f of failures) console.error("  - " + f);
      process.exitCode = 1;
      return;
    }

    await client.query("commit");
    committed = true;
    console.log("SONRA:", JSON.stringify(after.counts));
    console.log("\nFIXTURE CLEANUP: COMMIT edildi.");
  } catch (err) {
    try { await client.query("rollback"); } catch { /* bağlantı zaten kopmuş olabilir */ }
    throw err;
  } finally {
    client.release();
    await pool.end();
    if (before && after) {
      const out = process.env.MAS_FIXTURE_CLEANUP_OUT
        ?? "docs/release-evidence/final-production-readiness/12-fixture-cleanup.md";
      const rows = Object.keys(EXPECTED_AFTER)
        .map((t) => `| ${t} | ${before!.counts[t]} | ${after!.counts[t]} | ${EXPECTED_AFTER[t as keyof typeof EXPECTED_AFTER]} |`)
        .join("\n");
      const aggRows = Object.keys(before.agg)
        .map((k) => `| ${k} | ${before!.agg[k]} | ${after!.agg[k]} |`)
        .join("\n");
      writeFileSync(out,
        `# 12 — Fixture temizliği (P0-DRIFT-01)\n\n` +
        `TARGET DATABASE CLASS: PRODUCTION_WRITE\nTARGET DATABASE NAME: ${dbName}\n` +
        `REAL DB WRITE USED: YES — kullanıcının 2026-08-26 tarihli açık kararıyla\n` +
        `OFF-DEVICE MAKBUZ: ${proof.path} (sha256 ${proof.sha256.slice(0, 16)}…, hedef ${proof.target})\n` +
        `SONUÇ: ${committed ? "COMMIT" : "ROLLBACK"}\n\n` +
        `## Satır sayıları\n\n| tablo | önce | sonra | beklenen |\n|---|---:|---:|---:|\n${rows}\n\n` +
        `## Parasal toplamlar\n\n| ölçüt | önce | sonra |\n|---|---:|---:|\n${aggRows}\n\n` +
        (failures.length ? `## Başarısızlıklar\n\n${failures.map((f) => "- " + f).join("\n")}\n` : "") +
        `\n**FINAL: ${committed ? "PASS" : "ROLLBACK — hiçbir satır silinmedi"}**\n`,
        "utf8");
      console.log(`Kanıt: ${out}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
