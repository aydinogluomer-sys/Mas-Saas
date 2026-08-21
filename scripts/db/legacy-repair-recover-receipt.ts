// P0-B Slice 5 — the sole source of post-crash truth for the legacy repair toolchain.
// Reads an existing pending receipt (a crash left it as the only artifact — the process
// died somewhere between opening the pending file and returning from COMMIT) and
// independently re-verifies, row by row, that the repair it describes actually committed
// before it will ever produce a committed receipt. Never guesses, never re-derives a
// hash — every value in the produced receipt either comes straight from the pending file
// (already fixed and hash-bound) or from a fresh row this tool itself just read from the
// DB. This tool NEVER produces a rolled_back receipt — only the live apply process can
// affirmatively witness a rollback; if no DB evidence is found here, the outcome is
// reported as unresolved, requiring manual investigation.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
  CommittedReceiptFileSchema,
  PendingReceiptFileSchema,
  canonicalSerialize,
  fileSha256,
  payloadSha256,
  writeViaTempAndRename,
  type AppliedRepairResult,
  type CommittedReceiptFile,
} from "./legacy-repair-types";
import { ownerDatabaseUrl } from "./owner-url";

const TO_CHAR_INSTANT = `to_char($COL$ at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const ACTION_FOR_KIND: Record<AppliedRepairResult["kind"], string> = {
  archive_cascade_repair: "legacy_archive_cascade_repair",
  cancellation_metadata_repair: "legacy_cancel_metadata_repair",
};

interface Args {
  pending: string;
  expectedPendingSha256?: string;
  expectedDatabaseName: string;
  outDir?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const required = (flag: string): string => {
    const v = get(flag);
    if (!v) throw new Error(`${flag} zorunlu.`);
    return v;
  };
  return {
    pending: required("--pending"),
    expectedPendingSha256: get("--expected-pending-sha256"),
    expectedDatabaseName: required("--expected-database-name"),
    outDir: get("--out-dir"),
  };
}

function fail(message: string): never {
  console.error(`GÜVENLİK DURDURMASI: ${message}`);
  process.exit(1);
}

function unresolved(message: string): never {
  console.error(`ÇÖZÜLEMEDİ: ${message}`);
  process.exit(1);
}

function dbNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const pendingBytes = readFileSync(args.pending);
  const realPendingSha256 = fileSha256(pendingBytes);
  const pendingParsed = PendingReceiptFileSchema.safeParse(JSON.parse(pendingBytes.toString("utf8")));
  if (!pendingParsed.success) fail(`pending dosyası strict şemadan geçemedi: ${pendingParsed.error.message}`);
  const pending = pendingParsed.data;
  const { receiptCore, receiptCoreSha256 } = pending;
  if (payloadSha256(receiptCore) !== receiptCoreSha256) {
    fail("pending dosyasının iç receiptCoreSha256'sı tutarsız — dosya elle değiştirilmiş olabilir.");
  }

  if (!args.expectedPendingSha256) {
    console.log(`RAPOR MODU (--expected-pending-sha256 verilmedi, hiçbir committed receipt üretilmeyecek).`);
    console.log(`  operationId: ${pending.operationId}`);
    console.log(`  pending dosyasının gerçek fileSha256'sı: ${realPendingSha256}`);
    const databaseUrl = ownerDatabaseUrl();
    if (!databaseUrl) fail("MIGRATION_DATABASE_URL (veya DATABASE_URL) açıkça verilmeli.");
    const parsedName = dbNameFromUrl(databaseUrl);
    if (parsedName !== args.expectedDatabaseName) fail("DATABASE_URL'deki DB adı --expected-database-name ile eşleşmiyor.");
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const live = await pool.query<{ db: string }>(`select current_database() as db`);
      if (live.rows[0].db !== args.expectedDatabaseName) fail("Canlı current_database() beklenen adla eşleşmiyor.");
      const summary = await pool.query<{ after_data: { pendingFileSha256?: string } }>(
        `select after_data from public.audit_logs where action='legacy_repair_summary' and after_data->>'operationId'=$1`,
        [pending.operationId],
      );
      if (summary.rowCount === 0) {
        console.log(`  DB'de bu operationId için hiçbir legacy_repair_summary satırı yok (summary INSERT hiç çalışmamış veya rollback edilmiş olabilir).`);
      } else if (summary.rowCount === 1) {
        console.log(`  DB'deki legacy_repair_summary.after_data.pendingFileSha256: ${summary.rows[0].after_data.pendingFileSha256}`);
        console.log(`  eşleşiyor mu: ${summary.rows[0].after_data.pendingFileSha256 === realPendingSha256}`);
      } else {
        console.log(`  UYARI: DB'de bu operationId için ${summary.rowCount} legacy_repair_summary satırı var (beklenen 0 veya 1) — bu normalde asla olmamalı.`);
      }
    } finally {
      await pool.end();
    }
    return;
  }

  if (realPendingSha256 !== args.expectedPendingSha256) {
    fail("pending dosyasının gerçek byte SHA-256'sı --expected-pending-sha256 ile eşleşmiyor.");
  }

  const databaseUrl = ownerDatabaseUrl();
  if (!databaseUrl) fail("MIGRATION_DATABASE_URL (veya DATABASE_URL) açıkça verilmeli.");
  const parsedName = dbNameFromUrl(databaseUrl);
  if (parsedName !== args.expectedDatabaseName) fail("DATABASE_URL'deki DB adı --expected-database-name ile eşleşmiyor.");
  if (receiptCore.databaseName !== args.expectedDatabaseName) fail("receiptCore.databaseName --expected-database-name ile eşleşmiyor.");

  const outDir = args.outDir ?? path.dirname(args.pending);
  const committedPath = path.join(outDir, `${pending.operationId}.receipt.committed.json`);
  if (existsSync(committedPath)) {
    const existingBytes = readFileSync(committedPath);
    let existingJson: unknown;
    try {
      existingJson = JSON.parse(existingBytes.toString("utf8"));
    } catch {
      fail(`${committedPath} zaten mevcut ama geçerli JSON değil — üzerine güvenle yazılamaz. Elle inceleyin.`);
    }
    const existingParsed = CommittedReceiptFileSchema.safeParse(existingJson);
    if (!existingParsed.success) {
      fail(`${committedPath} zaten mevcut ama strict şemadan geçemiyor — üzerine güvenle yazılamaz. Elle inceleyin.`);
    }
    if (existingParsed.data.finalizationMode === "normal") {
      fail(
        `${committedPath} zaten finalizationMode='normal' ile mevcut — bu operasyon normal yoldan başarıyla commit edilmiş. Recovery bunun üzerine 'recovered' olarak yazamaz.`,
      );
    }
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  try {
    const live = await pool.query<{ db: string; sysid: string }>(
      `select current_database() as db, (select system_identifier::text from pg_control_system()) as sysid`,
    );
    if (live.rows[0].db !== args.expectedDatabaseName) fail("Canlı current_database() beklenen adla eşleşmiyor.");
    if (live.rows[0].sysid !== receiptCore.systemIdentifier) fail("Canlı system_identifier receiptCore ile eşleşmiyor.");

    // ledgerCount ve lastMigrationVersion AYRI AYRI karşılaştırılır — biri diğerini
    // maskeleyebileceği için (örn. bir satır silinip başka bir satır eklenirse count aynı
    // kalırken version değişebilir) tek bir birleşik kontrol yeterli değildir.
    const ledger = await pool.query<{ n: string; last_version: string | null }>(
      `select count(*)::text as n, max(version) as last_version from public.schema_migrations`,
    );
    if (Number(ledger.rows[0].n) !== receiptCore.ledgerCount) {
      fail(`Canlı ledgerCount (${ledger.rows[0].n}) receiptCore.ledgerCount (${receiptCore.ledgerCount}) ile eşleşmiyor.`);
    }
    if (ledger.rows[0].last_version !== receiptCore.lastMigrationVersion) {
      fail(`Canlı lastMigrationVersion (${ledger.rows[0].last_version}) receiptCore.lastMigrationVersion (${receiptCore.lastMigrationVersion}) ile eşleşmiyor.`);
    }

    const summary = await pool.query<{
      id: string; created_at_iso: string; after_data: Record<string, unknown>;
    }>(
      `select id, ${TO_CHAR_INSTANT.replace("$COL$", "created_at")} as created_at_iso, after_data
       from public.audit_logs where action='legacy_repair_summary' and after_data->>'operationId'=$1`,
      [pending.operationId],
    );
    if (summary.rowCount === 0) {
      unresolved(
        `DB'de operationId=${pending.operationId} için hiçbir legacy_repair_summary satırı bulunamadı — bu repair'ın gerçekten commit edip etmediği belirsiz. Elle inceleme gerekli (rollback mi oldu, yoksa summary INSERT'ten önce mi çöktü?). Hiçbir receipt üretilmedi.`,
      );
    }
    if (summary.rowCount! > 1) {
      fail(`DB'de operationId=${pending.operationId} için ${summary.rowCount} legacy_repair_summary satırı var (beklenen tam 1) — bu asla olmamalı.`);
    }
    const row = summary.rows[0];
    const after = row.after_data;

    if (after.pendingFileSha256 !== realPendingSha256) {
      fail("DB'deki summary.after_data.pendingFileSha256, bu pending dosyanın gerçek byte hash'iyle eşleşmiyor.");
    }
    if (after.receiptCoreSha256 !== receiptCoreSha256) fail("summary.after_data.receiptCoreSha256 pending ile eşleşmiyor.");
    if (after.transactionTimestamp !== receiptCore.transactionTimestamp) fail("summary.after_data.transactionTimestamp pending ile eşleşmiyor.");
    if (after.inventoryFileSha256 !== receiptCore.inventoryFileSha256) fail("summary.after_data.inventoryFileSha256 pending ile eşleşmiyor.");
    if (after.approvalFileSha256 !== receiptCore.approvalFileSha256) fail("summary.after_data.approvalFileSha256 pending ile eşleşmiyor.");
    if (after.backupSha256 !== receiptCore.backupSha256) fail("summary.after_data.backupSha256 pending ile eşleşmiyor.");
    if (after.backupReceiptSha256 !== receiptCore.backupReceiptSha256) fail("summary.after_data.backupReceiptSha256 pending ile eşleşmiyor.");
    // JSONB does not preserve object-key insertion order the way it was written — a
    // naive JSON.stringify comparison would spuriously fail even when the DATA is
    // identical, purely because Postgres reordered keys within each array element.
    // canonicalSerialize sorts keys (but preserves array element order, which DOES
    // matter here) on both sides, making this comparison order-of-keys-independent
    // while still catching any real content or ordering difference.
    if (canonicalSerialize(after.appliedRepairs) !== canonicalSerialize(receiptCore.appliedRepairs)) {
      fail("summary.after_data.appliedRepairs pending ile eşleşmiyor.");
    }
    if (after.untouchedScopeAfterHash !== receiptCore.untouchedScopeAfterHash) {
      fail("summary.after_data.untouchedScopeAfterHash pending ile eşleşmiyor.");
    }

    // Row-level audit proof: every applied repair's own auditId is independently
    // re-verified against a freshly-read audit_logs row — existence, action-per-kind,
    // entity linkage, and (for cascade repairs only — metadata repairs deliberately keep
    // their own audit row's created_at at DEFAULT now(), see engine.ts) exact
    // created_at match against the shared transaction timestamp.
    const seenInstanceIds = new Set<string>();
    for (const repair of receiptCore.appliedRepairs) {
      const expectedAction = ACTION_FOR_KIND[repair.kind];
      const r = await pool.query<{
        id: string; action: string; entity_id: string | null; entity_table: string; created_at_iso: string;
      }>(
        `select id, action, entity_id, entity_table, ${TO_CHAR_INSTANT.replace("$COL$", "created_at")} as created_at_iso
         from public.audit_logs where id=$1`,
        [repair.auditId],
      );
      if (r.rowCount !== 1) {
        fail(`audit satırı bulunamadı: ${repair.auditId} (beklenen tam 1, alınan ${r.rowCount}) — receiptCore satır-bazlı kanıtı doğrulanamadı.`);
      }
      const a = r.rows[0];
      if (a.action !== expectedAction) fail(`audit satırı (${repair.auditId}) action='${a.action}' — beklenen '${expectedAction}'.`);
      if (a.entity_table !== "payment_instances") fail(`audit satırı (${repair.auditId}) entity_table='${a.entity_table}' — beklenen 'payment_instances'.`);
      if (a.entity_id !== repair.instanceId) {
        fail(`audit satırı (${repair.auditId}) entity_id (${a.entity_id}) receiptCore girdisinin instanceId'siyle (${repair.instanceId}) eşleşmiyor.`);
      }
      if (repair.kind === "archive_cascade_repair" && a.created_at_iso !== receiptCore.transactionTimestamp) {
        fail(`cascade audit satırı (${repair.auditId}) created_at (${a.created_at_iso}) receiptCore.transactionTimestamp (${receiptCore.transactionTimestamp}) ile birebir eşleşmiyor.`);
      }
      seenInstanceIds.add(a.entity_id);
    }
    if (seenInstanceIds.size !== receiptCore.appliedRepairs.length) {
      fail("Doğrulanan audit satırlarının entity_id kümesi receiptCore.appliedRepairs ile tam eşleşmiyor (eksik veya fazla bir audit ID var).");
    }

    writeViaTempAndRename(
      committedPath,
      (durability) => {
        const committedFile: CommittedReceiptFile = {
          status: "committed",
          operationId: pending.operationId,
          receiptCore,
          receiptCoreSha256,
          pendingFileSha256: realPendingSha256,
          summaryAuditId: row.id,
          summaryAuditCreatedAt: row.created_at_iso,
          finalizationMode: "recovered",
          durability,
        };
        const parsed = CommittedReceiptFileSchema.safeParse(committedFile);
        if (!parsed.success) throw new Error(`üretilen committed receipt kendi şemasından geçemedi (programlama hatası): ${parsed.error.message}`);
        return JSON.stringify(parsed.data, null, 2);
      },
      (text) => {
        const parsed = CommittedReceiptFileSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`committed receipt kendi şemasından geçemedi: ${parsed.error.message}`);
      },
    );

    console.log(`Recovery başarılı. committed receipt yazıldı: ${committedPath}`);
    console.log(`  operationId: ${pending.operationId}`);
    console.log(`  summaryAuditId: ${row.id}`);
    console.log(`  finalizationMode: recovered`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("legacy-repair-recover-receipt beklenmedik hata ile durdu:", err);
  process.exit(1);
});
