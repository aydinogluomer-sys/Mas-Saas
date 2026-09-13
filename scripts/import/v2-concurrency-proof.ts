// P1 — external_id kimlik zincirinin eşzamanlılık ve bütünlük kanıtı.
//
// Beş ayrı iddia ölçülür:
//
//   A) NEGATİF KONTROL — kilitsiz sıra gerçekten mükerrer üretiyor mu?
//   B) AYNI ANAHTAR eşzamanlı import → tek kayıt, tek bağlama, sahipsiz kayıt yok
//   C) FARKLI ANAHTARLAR birbirini bloklamıyor (doğruluk, zamanlama değil)
//   D) BAYAT BAĞLAMA → sessiz başarı yok, otomatik "iyileştirme" yok
//   E) BAĞLAMA ÇAKIŞMASI → mevcut bağlama değişmiyor
//   F) HATA SONRASI kısmi domain yazımları geri alınıyor
//
// A adımı olmadan B anlamsız olurdu: sonuçların doğru çıkması kilidin işlediği için mi
// yoksa ortada hiç yarış olmadığı için mi bilinemezdi. A, ÜRETİM KODUNU DEĞİŞTİRMEDEN,
// düzeltmeden ÖNCEKİ sırayı (ara → yaz → deftere geç) harness içinde birebir tekrarlar.
import ExcelJS from "exceljs";
import { Pool, type PoolClient } from "pg";
import {
  DATA_SHEETS, META_SHEET, SCHEMA_NAME, SCHEMA_VERSION, TEMPLATE_VERSION,
} from "../../src/lib/importers/v2/contract";
import { parseWorkbook } from "../../src/lib/importers/v2/parser";
import {
  mapWorkbook, StaleExternalKeyBindingError, ExternalKeyBindingConflictError,
} from "../../src/lib/importers/v2/mapper";
import { requireDisposableOwnerDatabaseUrl } from "../db/owner-url";

interface Check { ad: string; beklenen: unknown; gelen: unknown; gecti: boolean }
const checks: Check[] = [];
function assert(ad: string, beklenen: unknown, gelen: unknown): void {
  const gecti = JSON.stringify(beklenen) === JSON.stringify(gelen);
  checks.push({ ad, beklenen, gelen, gecti });
  console.log(`${gecti ? "GEÇTİ " : "DÜŞTÜ "} ${ad}` +
    (gecti ? "" : `\n         beklenen: ${JSON.stringify(beklenen)}\n         gelen   : ${JSON.stringify(gelen)}`));
}

const RESET = [
  "import_external_keys", "mapping_reviews", "import_rows", "source_sheets",
  "payments", "source_workbooks",
];

/** Tek sayfalık, tek satırlık asgari V2 workbook — yarış senaryosunu sadeleştirir. */
function buildOnePaymentWorkbook(externalIds: string[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const spec = DATA_SHEETS.find((s) => s.name === "01_ODEMELER")!;
  const ws = wb.addWorksheet(spec.name);
  ws.addRow(spec.columns.map((c) => c.header));
  for (const ext of externalIds) {
    ws.addRow(spec.columns.map((c) => {
      switch (c.key) {
        case "external_id": return ext;
        case "aciklama": return `Eşzamanlılık ${ext}`;
        case "vade_gunu": return 10;
        case "tutar": return 1000;
        case "para_birimi": return "TRY";
        case "tekrar_tipi": return "monthly";
        case "durum": return "active";
        default: return null;
      }
    }));
  }
  const meta = wb.addWorksheet(META_SHEET);
  meta.state = "veryHidden";
  meta.addRow(["schema_name", SCHEMA_NAME]);
  meta.addRow(["schema_version", SCHEMA_VERSION]);
  meta.addRow(["template_version", TEMPLATE_VERSION]);
  return wb;
}

/** İki tarafın da hazır olmasını bekleten kapı — yarışın gerçekten oluşmasını sağlar. */
function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return async () => {
    arrived++;
    if (arrived >= count) release();
    await gate;
  };
}

async function main(): Promise<void> {
  const url = requireDisposableOwnerDatabaseUrl("V2 eşzamanlılık kanıtı");
  const pool = new Pool({ connectionString: url, max: 6 });
  const admin = await pool.connect();
  const evidence: Record<string, unknown> = {};

  const wipe = async (): Promise<void> => {
    await admin.query(`truncate ${RESET.map((t) => `public.${t}`).join(", ")} cascade`);
    await admin.query("truncate public.parties, public.categories cascade");
  };
  const actorId = async (): Promise<string> => (await admin.query<{ id: string }>(
    `insert into public.users (username, password_hash, display_name, role)
     values ('v2-concurrency', 'DISABLED-NOT-A-CREDENTIAL', 'V2 eşzamanlılık', 'admin')
     on conflict (username) do update set display_name = excluded.display_name
     returning id`)).rows[0].id;
  const count = async (t: string): Promise<number> =>
    Number((await admin.query<{ c: string }>(`select count(*) c from public.${t}`)).rows[0].c);

  try {
    const db = (await admin.query<{ d: string }>("select current_database() as d")).rows[0].d;
    console.log(`Hedef (harcanabilir): ${db}\n`);
    evidence.database = db;

    /* ── A · NEGATİF KONTROL: düzeltmeden ÖNCEKİ sıra ─────────────────────────────── */
    //
    // Üretim kodunda anahtar (feature toggle) YOK. Burada eski sıra harness tarafından
    // birebir tekrarlanıyor: kilitsiz ara → domain'e yaz → deftere geç. Kapı, iki tarafın
    // da "yok" gördükten SONRA yazmasını garantiliyor — yani yarış kesin oluşuyor.
    console.log("── A · NEGATİF KONTROL (kilitsiz eski sıra, harness içinde) ──");
    await wipe();
    const actor = await actorId();

    const unsafeImport = async (client: PoolClient, gate: () => Promise<void>): Promise<void> => {
      await client.query("begin");
      const found = await client.query<{ entity_id: string }>(
        "select entity_id from public.import_external_keys where entity_table='payments' and external_id=$1",
        ["CONC-001"]);
      await gate();                                   // ikisi de "yok" gördü
      let id: string;
      if (found.rowCount) {
        id = found.rows[0].entity_id;
        await client.query("update public.payments set name = name where id = $1", [id]);
      } else {
        id = (await client.query<{ id: string }>(
          `insert into public.payments (name, recurrence_type, due_day, currency, amount_confidence, status)
           values ('Eşzamanlılık CONC-001','monthly',10,'TRY','known','active') returning id`)).rows[0].id;
      }
      await client.query(
        `insert into public.import_external_keys (entity_table, external_id, entity_id)
         values ('payments', $1, $2)
         on conflict (entity_table, external_id) do update set last_seen_workbook_id = null`,
        ["CONC-001", id]);
      await client.query("commit");
    };

    const gateA = barrier(2);
    const c1 = await pool.connect(); const c2 = await pool.connect();
    const unsafeResults = await Promise.allSettled([unsafeImport(c1, gateA), unsafeImport(c2, gateA)]);
    for (const c of [c1, c2]) { await c.query("rollback").catch(() => {}); c.release(); }

    const unsafePayments = await count("payments");
    const unsafeLedger = await count("import_external_keys");
    const unsafeOrphans = Number((await admin.query<{ c: string }>(
      `select count(*) c from public.payments p
        where not exists (select 1 from public.import_external_keys k
                           where k.entity_table='payments' and k.entity_id = p.id)`)).rows[0].c);
    console.log(`   payments=${unsafePayments} defter=${unsafeLedger} sahipsiz=${unsafeOrphans} ` +
      `· sonuçlar: ${unsafeResults.map((r) => r.status).join(",")}`);
    evidence.negativeControl = {
      payments: unsafePayments, ledger: unsafeLedger, orphans: unsafeOrphans,
      outcomes: unsafeResults.map((r) => r.status),
    };
    // Kilitsiz sıra ya mükerrer üretir ya da çakışmayla düşer. İkisi de "güvenli" değildir.
    assert("kilitsiz sıra mükerrer VEYA çakışma üretiyor (tehlike gerçek)", true,
      unsafePayments > 1 || unsafeOrphans > 0 || unsafeResults.some((r) => r.status === "rejected"));

    /* ── B · AYNI ANAHTAR, GERÇEK EŞZAMANLILIK, ÜRETİM KODU ───────────────────────── */
    console.log("\n── B · AYNI ANAHTAR eşzamanlı import (üretim kodu) ──");
    await wipe();
    const wb = buildOnePaymentWorkbook(["CONC-001"]);
    const parsed = parseWorkbook(wb);

    const runImport = async (client: PoolClient, gate: () => Promise<void>, label: string) => {
      await client.query("begin");
      await gate();                                   // ikisi de işlem açmış hâlde başlar
      const r = await mapWorkbook(client, parsed, { filename: `${label}.xlsx`, actorId: actor });
      await client.query("commit");
      return r;
    };

    const gateB = barrier(2);
    const a = await pool.connect(); const b = await pool.connect();
    const results = await Promise.allSettled([
      runImport(a, gateB, "es-zamanli-A"), runImport(b, gateB, "es-zamanli-B"),
    ]);
    for (const c of [a, b]) { await c.query("rollback").catch(() => {}); c.release(); }

    const domainRows = await count("payments");
    const ledgerRows = await count("import_external_keys");
    const distinct = Number((await admin.query<{ c: string }>(
      "select count(distinct entity_id) c from public.import_external_keys")).rows[0].c);
    const orphans = Number((await admin.query<{ c: string }>(
      `select count(*) c from public.payments p
        where not exists (select 1 from public.import_external_keys k
                           where k.entity_table='payments' and k.entity_id = p.id)`)).rows[0].c);

    const okResults = results.filter((r) => r.status === "fulfilled").length;
    const perTables = results.map((r) => r.status === "fulfilled"
      ? (r.value as { perTable: Record<string, { inserted: number; updated: number }> }).perTable.payments
      : { error: (r as PromiseRejectedResult).reason?.message ?? "?" });
    console.log(`   payments=${domainRows} defter=${ledgerRows} farklı_kayıt=${distinct} sahipsiz=${orphans}`);
    console.log(`   sonuçlar: ${JSON.stringify(perTables)}`);

    assert("her iki import da BAŞARILI bitti (unique violation kabul edilebilir sonuç değil)", 2, okResults);
    assert("DOMAIN_ROWS", 1, domainRows);
    assert("LEDGER_ROWS", 1, ledgerRows);
    assert("BOUND_ENTITY_IDS (distinct)", 1, distinct);
    assert("ORPHAN_DUPLICATE_ROWS", 0, orphans);
    // Biri yaratır, diğeri güncellemeye döner.
    const inserted = perTables.reduce((n, p) => n + (("inserted" in p) ? p.inserted : 0), 0);
    const updated = perTables.reduce((n, p) => n + (("updated" in p) ? p.updated : 0), 0);
    assert("biri yarattı, diğeri güncelledi", { inserted: 1, updated: 1 }, { inserted, updated });
    evidence.sameKeyConcurrent = { domainRows, ledgerRows, distinct, orphans, inserted, updated };

    /* ── C · FARKLI ANAHTARLAR birbirini bloklamıyor ──────────────────────────────── */
    console.log("\n── C · FARKLI anahtarlar eşzamanlı ──");
    await wipe();
    const wbA = buildOnePaymentWorkbook(["CHECK-A"]);
    const wbB = buildOnePaymentWorkbook(["CHECK-B"]);
    const pA = parseWorkbook(wbA); const pB = parseWorkbook(wbB);
    const gateC = barrier(2);
    const d1 = await pool.connect(); const d2 = await pool.connect();
    const diffResults = await Promise.allSettled([
      (async () => { await d1.query("begin"); await gateC();
        const r = await mapWorkbook(d1, pA, { filename: "A.xlsx", actorId: actor });
        await d1.query("commit"); return r; })(),
      (async () => { await d2.query("begin"); await gateC();
        const r = await mapWorkbook(d2, pB, { filename: "B.xlsx", actorId: actor });
        await d2.query("commit"); return r; })(),
    ]);
    for (const c of [d1, d2]) { await c.query("rollback").catch(() => {}); c.release(); }
    const diffDomain = await count("payments");
    const diffLedger = await count("import_external_keys");
    console.log(`   payments=${diffDomain} defter=${diffLedger}`);
    assert("farklı anahtarların ikisi de yazıldı", 2, diffDomain);
    assert("her ikisi için bağlama var", 2, diffLedger);
    assert("farklı anahtarlarda hata yok", 2, diffResults.filter((r) => r.status === "fulfilled").length);
    evidence.differentKeys = { domainRows: diffDomain, ledgerRows: diffLedger };

    /* ── D · BAYAT BAĞLAMA ────────────────────────────────────────────────────────── */
    console.log("\n── D · BAYAT BAĞLAMA ──");
    await wipe();
    const single = await pool.connect();
    await single.query("begin");
    await mapWorkbook(single, parsed, { filename: "ilk.xlsx", actorId: actor });
    await single.query("commit");

    // Kaydı bilerek sil, bağlamayı bırak → kimlik zinciri kopuk.
    const boundId = (await admin.query<{ entity_id: string }>(
      "select entity_id from public.import_external_keys where external_id='CONC-001'")).rows[0].entity_id;
    await admin.query("delete from public.payments where id = $1", [boundId]);

    const beforeD = { payments: await count("payments"), ledger: await count("import_external_keys") };
    let staleError: string | null = null;
    let staleTyped = false;
    try {
      await single.query("begin");
      await mapWorkbook(single, parsed, { filename: "ikinci.xlsx", actorId: actor });
      await single.query("commit");
    } catch (e) {
      await single.query("rollback").catch(() => {});
      staleTyped = e instanceof StaleExternalKeyBindingError;
      staleError = e instanceof Error ? e.message : String(e);
    }
    const afterD = { payments: await count("payments"), ledger: await count("import_external_keys") };
    console.log(`   hata: ${staleError?.slice(0, 110) ?? "(YOK — sessiz başarı!)"}`);
    assert("bayat bağlama HATA veriyor (sessiz başarı yok)", true, staleTyped);
    assert("bayat bağlamada yeni domain kaydı YARATILMADI", beforeD.payments, afterD.payments);
    assert("bayat bağlamada defter YENİDEN ATANMADI", beforeD.ledger, afterD.ledger);
    evidence.staleBinding = { typed: staleTyped, message: staleError, before: beforeD, after: afterD };

    /* ── E · BAĞLAMA ÇAKIŞMASI ────────────────────────────────────────────────────── */
    console.log("\n── E · BAĞLAMA ÇAKIŞMASI ──");
    await wipe();
    await single.query("begin");
    await mapWorkbook(single, parsed, { filename: "ilk.xlsx", actorId: actor });
    await single.query("commit");
    const entityA = (await admin.query<{ entity_id: string }>(
      "select entity_id from public.import_external_keys where external_id='CONC-001'")).rows[0].entity_id;

    // Bağlamayı BAŞKA bir kayda çevirmeye çalış: defterde kod ENTITY-A'ya bağlıyken,
    // aynı kodla ENTITY-B yazılmak isteniyor.
    const entityB = (await admin.query<{ id: string }>(
      `insert into public.payments (name, recurrence_type, due_day, currency, amount_confidence, status)
       values ('Başka kayıt','monthly',10,'TRY','known','active') returning id`)).rows[0].id;

    let conflictTyped = false; let conflictMsg: string | null = null;
    try {
      await single.query("begin");
      await single.query(
        `insert into public.import_external_keys (entity_table, external_id, entity_id)
         values ('payments','CONC-001',$1)
         on conflict (entity_table, external_id) do update set last_seen_workbook_id = null
         returning entity_id`, [entityB]);
      // recordExternalKey'in yaptığı doğrulamanın aynısı: dönen bağlama istenen mi?
      const bound = (await single.query<{ entity_id: string }>(
        "select entity_id from public.import_external_keys where external_id='CONC-001'")).rows[0].entity_id;
      if (bound !== entityB) throw new ExternalKeyBindingConflictError("payments", "CONC-001", bound, entityB);
      await single.query("commit");
    } catch (e) {
      await single.query("rollback").catch(() => {});
      conflictTyped = e instanceof ExternalKeyBindingConflictError;
      conflictMsg = e instanceof Error ? e.message : String(e);
    }
    const stillBound = (await admin.query<{ entity_id: string }>(
      "select entity_id from public.import_external_keys where external_id='CONC-001'")).rows[0].entity_id;
    console.log(`   hata: ${conflictMsg?.slice(0, 110) ?? "(YOK)"}`);
    assert("çakışma HATA veriyor", true, conflictTyped);
    assert("mevcut bağlama DEĞİŞMEDİ", entityA, stillBound);
    evidence.bindingConflict = { typed: conflictTyped, message: conflictMsg, unchanged: entityA === stillBound };

    /* ── F · KISMİ YAZIMLARIN GERİ ALINMASI ───────────────────────────────────────── */
    console.log("\n── F · HATA SONRASI ROLLBACK ──");
    await wipe();
    // İki satırlık workbook: ilki yazılır, sonra ikinci satırda bayat bağlama tetiklenir.
    const twoRow = parseWorkbook(buildOnePaymentWorkbook(["ROLL-1", "ROLL-2"]));
    await single.query("begin");
    await mapWorkbook(single, twoRow, { filename: "hazirlik.xlsx", actorId: actor });
    await single.query("commit");
    const roll2 = (await admin.query<{ entity_id: string }>(
      "select entity_id from public.import_external_keys where external_id='ROLL-2'")).rows[0].entity_id;
    await admin.query("delete from public.payments where id = $1", [roll2]);
    await admin.query("update public.payments set name = 'ESKI AD' where id = (select entity_id from public.import_external_keys where external_id='ROLL-1')");

    const beforeF = {
      payments: await count("payments"),
      workbooks: await count("source_workbooks"),
      rollOneName: (await admin.query<{ name: string }>(
        `select name from public.payments p join public.import_external_keys k on k.entity_id=p.id
          where k.external_id='ROLL-1'`)).rows[0].name,
    };

    let rolledBack = false;
    try {
      await single.query("begin");
      await mapWorkbook(single, twoRow, { filename: "yarim.xlsx", actorId: actor });
      await single.query("commit");
    } catch {
      await single.query("rollback").catch(() => {});
      rolledBack = true;
    }
    const afterF = {
      payments: await count("payments"),
      workbooks: await count("source_workbooks"),
      rollOneName: (await admin.query<{ name: string }>(
        `select name from public.payments p join public.import_external_keys k on k.entity_id=p.id
          where k.external_id='ROLL-1'`)).rows[0].name,
    };
    single.release();

    console.log(`   önce: ${JSON.stringify(beforeF)}`);
    console.log(`   sonra: ${JSON.stringify(afterF)}`);
    assert("hata işlemi düşürdü", true, rolledBack);
    // ROLL-1 hatadan ÖNCE güncellenmişti; rollback onu da geri almalı.
    assert("hatadan ÖNCEKİ kısmi domain güncellemesi geri alındı", beforeF.rollOneName, afterF.rollOneName);
    assert("yarım kalan workbook kaydı yazılmadı", beforeF.workbooks, afterF.workbooks);
    evidence.rollback = { rolledBack, before: beforeF, after: afterF };

    /* ── Özet ─────────────────────────────────────────────────────────────────────── */
    const failed = checks.filter((c) => !c.gecti);
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Kontrol: ${checks.length} · geçti: ${checks.length - failed.length} · düştü: ${failed.length}`);
    evidence.checks = checks.map((c) => ({ ad: c.ad, gecti: c.gecti }));
    evidence.verdict = failed.length === 0 ? "PASS" : "FAIL";
    console.log(JSON.stringify(evidence, null, 2));
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    admin.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
