// P0-B Slice 5 — fail-closed apply for the legacy repair toolchain. Requires an immutable
// inventory manifest, a separately-produced approval manifest, a fresh verified backup +
// backup receipt — all cross-checked by EXTERNAL, CLI-supplied hashes before a single DB
// connection is opened. The actual repair runs in one transaction; a crash-safe receipt
// protocol (pending -> summary audit -> commit -> committed) means a process crash after
// commit is recoverable via legacy-repair-recover-receipt.ts, never silently misreported.
//
// COMMIT-OUTCOME SAFETY: a failure is classified into exactly one of three buckets before
// any receipt is written — see runRepairTransaction's catch block. Only a failure that
// happens strictly BEFORE the COMMIT call is ever reported as rolled_back; a failure
// during or after COMMIT never assumes an outcome and never touches the pending file.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { istanbulDateISO } from "../../src/lib/time/istanbul";
import { verifyRestoreListable } from "./backup-docker-postgres";
import {
  ApprovalManifestSchema,
  BackupReceiptSchema,
  CANONICALIZATION_VERSION,
  CommittedReceiptFileSchema,
  InventoryManifestSchema,
  PendingReceiptFileSchema,
  RolledBackReceiptFileSchema,
  canonicalHash,
  fileSha256,
  payloadSha256,
  sortIdsDeterministically,
  sortAppliedRepairsDeterministically,
  writeExclusiveDurable,
  writeViaTempAndRename,
  type ApprovalManifest,
  type BackupReceipt,
  type CommittedReceiptFile,
  type InventoryManifest,
  type InventoryTarget,
  type PendingReceiptFile,
  type ReceiptCore,
  type RolledBackReceiptFile,
} from "./legacy-repair-types";

const FRESHNESS_WINDOW_MS = 30 * 60 * 1000;
const TO_CHAR_INSTANT = `to_char($COL$ at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface Args {
  inventory: string; expectedInventorySha256: string;
  approval: string; expectedApprovalSha256: string;
  backup: string; expectedBackupSha256: string;
  backupReceipt: string; expectedBackupReceiptSha256: string;
  expectedDatabaseName: string;
  container: string;
  receiptsDir: string;
  apply: boolean;
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
    inventory: required("--inventory"),
    expectedInventorySha256: required("--expected-inventory-sha256"),
    approval: required("--approval"),
    expectedApprovalSha256: required("--expected-approval-sha256"),
    backup: required("--backup"),
    expectedBackupSha256: required("--expected-backup-sha256"),
    backupReceipt: required("--backup-receipt"),
    expectedBackupReceiptSha256: required("--expected-backup-receipt-sha256"),
    expectedDatabaseName: required("--expected-database-name"),
    container: required("--container"),
    receiptsDir: get("--receipts-dir") ?? path.join(process.cwd(), "backups", "legacy-repair-receipts"),
    apply: argv.includes("--apply"),
  };
}

function fail(message: string): never {
  console.error(`GÜVENLİK DURDURMASI: ${message}`);
  process.exit(1);
}

function dbNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

interface Stage2Result {
  inventory: InventoryManifest;
  inventoryFileSha256: string;
  approval: ApprovalManifest;
  approvalFileSha256: string;
  backupReceipt: BackupReceipt;
  backupReceiptFileSha256: string;
}

/** Stage A: pure file-level verification — byte hashes, schema, self-consistency,
 * cross-file binding. No DB connection is opened here. */
function verifyFilesOffline(args: Args): Stage2Result {
  const inventoryBytes = readFileSync(args.inventory);
  const inventoryFileSha256 = fileSha256(inventoryBytes);
  if (inventoryFileSha256 !== args.expectedInventorySha256) {
    fail(`inventory dosyasının byte SHA-256'sı beklenenle eşleşmiyor.`);
  }
  const inventoryParsed = InventoryManifestSchema.safeParse(JSON.parse(inventoryBytes.toString("utf8")));
  if (!inventoryParsed.success) fail(`inventory dosyası strict şemadan geçemedi: ${inventoryParsed.error.message}`);
  const inventory = inventoryParsed.data;
  {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
    const { generatedAt: _g, inventoryPayloadSha256: _h, durability: _d, ...rest } = inventory;
    if (payloadSha256(rest) !== inventory.inventoryPayloadSha256) {
      fail("inventory dosyasının iç inventoryPayloadSha256'sı tutarsız — elle değiştirilmiş olabilir.");
    }
  }

  const approvalBytes = readFileSync(args.approval);
  const approvalFileSha256 = fileSha256(approvalBytes);
  if (approvalFileSha256 !== args.expectedApprovalSha256) {
    fail(`approval dosyasının byte SHA-256'sı beklenenle eşleşmiyor.`);
  }
  const approvalParsed = ApprovalManifestSchema.safeParse(JSON.parse(approvalBytes.toString("utf8")));
  if (!approvalParsed.success) fail(`approval dosyası strict şemadan geçemedi: ${approvalParsed.error.message}`);
  const approval = approvalParsed.data;
  {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
    const { approvedAt: _a, approvalPayloadSha256: _h, durability: _d, ...rest } = approval;
    if (payloadSha256(rest) !== approval.approvalPayloadSha256) {
      fail("approval dosyasının iç approvalPayloadSha256'sı tutarsız — elle değiştirilmiş olabilir.");
    }
  }
  if (approval.inventoryFileSha256 !== inventoryFileSha256) {
    fail("approval dosyası başka bir inventory dosyasının SHA-256'sına bağlı — bu tam olarak bu inventory'yi onaylamıyor.");
  }

  const backupReceiptBytes = readFileSync(args.backupReceipt);
  const backupReceiptFileSha256 = fileSha256(backupReceiptBytes);
  if (backupReceiptFileSha256 !== args.expectedBackupReceiptSha256) {
    fail("backup receipt dosyasının byte SHA-256'sı beklenenle eşleşmiyor.");
  }
  const backupReceiptParsed = BackupReceiptSchema.safeParse(JSON.parse(backupReceiptBytes.toString("utf8")));
  if (!backupReceiptParsed.success) fail(`backup receipt strict şemadan geçemedi: ${backupReceiptParsed.error.message}`);
  const backupReceipt = backupReceiptParsed.data;

  const backupBytes = readFileSync(args.backup);
  const realBackupSha256 = fileSha256(backupBytes);
  if (realBackupSha256 !== args.expectedBackupSha256) fail("backup dosyasının gerçek byte SHA-256'sı beklenenle eşleşmiyor.");
  if (realBackupSha256 !== backupReceipt.sha256) fail("backup dosyasının gerçek SHA-256'sı, receipt'in kaydettiği SHA-256 ile eşleşmiyor.");
  if (backupBytes.length !== backupReceipt.bytes) fail("backup dosyasının gerçek boyutu receipt'teki boyutla eşleşmiyor.");
  try {
    verifyRestoreListable(args.container, args.backup);
  } catch (err) {
    fail(`backup dosyası okunabilirlik doğrulamasından geçemedi: ${(err as Error).message}`);
  }

  if (backupReceipt.databaseName !== inventory.databaseName) fail("backup receipt'in databaseName'i inventory ile eşleşmiyor.");
  if (backupReceipt.systemIdentifier !== inventory.systemIdentifier) fail("backup receipt'in systemIdentifier'ı inventory ile eşleşmiyor.");
  if (backupReceipt.ledgerCount !== inventory.ledgerCount) fail("backup receipt'in ledgerCount'u inventory ile eşleşmiyor.");
  if (backupReceipt.lastMigrationVersion !== inventory.lastMigrationVersion) fail("backup receipt'in lastMigrationVersion'ı inventory ile eşleşmiyor.");

  const inventoryGenAt = new Date(inventory.generatedAt).getTime();
  const approvedAt = new Date(approval.approvedAt).getTime();
  const backupCompleted = new Date(backupReceipt.backupCompletedDbTimestamp).getTime();
  if (!(inventoryGenAt <= approvedAt)) fail("approval, inventory'den önce üretilmiş görünüyor — tazelik sırası bozuk.");
  if (!(approvedAt <= backupCompleted)) fail("backup, approval'dan önce alınmış görünüyor — tazelik sırası bozuk.");

  return { inventory, inventoryFileSha256, approval, approvalFileSha256, backupReceipt, backupReceiptFileSha256 };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { inventory, inventoryFileSha256, approval, approvalFileSha256, backupReceipt, backupReceiptFileSha256 } = verifyFilesOffline(args);

  if (inventory.databaseName !== args.expectedDatabaseName) {
    fail("--expected-database-name inventory'nin databaseName'iyle eşleşmiyor.");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL açıkça verilmeli.");
  const parsedName = dbNameFromUrl(databaseUrl);
  if (parsedName !== args.expectedDatabaseName) fail("DATABASE_URL'deki DB adı --expected-database-name ile eşleşmiyor.");

  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (gitHead !== inventory.gitHead) fail("Canlı git HEAD, inventory'nin gitHead'iyle eşleşmiyor.");

  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  try {
    const live = await pool.query<{ db: string; sysid: string }>(
      `select current_database() as db, (select system_identifier::text from pg_control_system()) as sysid`,
    );
    if (live.rows[0].db !== args.expectedDatabaseName) fail("Canlı current_database() beklenen adla eşleşmiyor.");
    if (live.rows[0].sysid !== inventory.systemIdentifier) fail("Canlı system_identifier inventory ile eşleşmiyor.");

    const ledger = await pool.query<{ n: string; last_version: string | null }>(
      `select count(*)::text as n, max(version) as last_version from public.schema_migrations`,
    );
    if (Number(ledger.rows[0].n) !== inventory.ledgerCount || ledger.rows[0].last_version !== inventory.lastMigrationVersion) {
      fail("Canlı ledger durumu inventory'nin kaydettiği durumdan farklı — DB, inventory alındıktan sonra değişmiş.");
    }

    const nowRes = await pool.query<{ now_iso: string }>(
      `select ${TO_CHAR_INSTANT.replace("$COL$", "clock_timestamp()")} as now_iso`,
    );
    const nowMs = new Date(nowRes.rows[0].now_iso).getTime();
    const backupAgeMs = nowMs - new Date(backupReceipt.backupCompletedDbTimestamp).getTime();
    if (backupAgeMs > FRESHNESS_WINDOW_MS || backupAgeMs < 0) {
      fail(`Backup tazelik penceresini aşıyor (${Math.round(backupAgeMs / 1000)}s, limit ${FRESHNESS_WINDOW_MS / 1000}s) — yeni bir backup alın.`);
    }

    // Europe/Istanbul civil date, same host-clock methodology legacy-repair-inventory.ts
    // used to compute inventory.todayISO — a UTC slice of a DB timestamp would misalign
    // near the daily UTC/Istanbul boundary (Turkey is fixed UTC+3, no DST).
    const applyTodayISO = istanbulDateISO();
    if (applyTodayISO !== inventory.todayISO) {
      fail(`Apply günü (${applyTodayISO}) inventory'nin todayISO'sundan (${inventory.todayISO}) farklı — freshness kuralı gereği yeni bir inventory+approval çifti gerekli.`);
    }

    if (!args.apply) {
      console.log("Tüm önkoşullar geçti. --apply verilmediği için hiçbir transaction açılmadı, hiçbir DML çalışmadı.");
      return;
    }

    await runRepairTransaction(pool, args, inventory, approval, {
      inventoryFileSha256,
      approvalFileSha256,
      backupSha256: args.expectedBackupSha256,
      backupReceiptSha256: backupReceiptFileSha256,
      gitHead,
    });
  } finally {
    await pool.end();
  }
}

interface FixedHashes {
  inventoryFileSha256: string; approvalFileSha256: string; backupSha256: string; backupReceiptSha256: string; gitHead: string;
}

/** Every stage this transaction can be interrupted at. "commit" covers both "the COMMIT
 * call itself is in flight/just failed" AND, together with `commitConfirmed`, "COMMIT
 * definitely succeeded but something after it (the committed-receipt write) failed" —
 * the two are told apart by `commitConfirmed`, not by a separate stage value. Only the
 * five stages strictly before "commit" ever produce a rolled_back receipt — see
 * RolledBackReceiptFileSchema, which deliberately does not include "commit" at all. */
type ApplyStage = "precondition" | "eligibility" | "repair_update" | "pending_write" | "summary_audit_insert" | "commit";

async function runRepairTransaction(
  pool: Pool,
  args: Args,
  inventory: InventoryManifest,
  approval: ApprovalManifest,
  hashes: FixedHashes,
): Promise<void> {
  const { writeLegacyRepairSummaryWithClient, cancelInstanceWithClient, repairCancellationMetadataWithClient } = await import(
    "../../src/lib/radar/engine"
  );

  const operationId = randomUUID();
  const client = await pool.connect();
  let stage: ApplyStage = "precondition";
  let commitConfirmed = false;
  let pendingFileSha256: string | null = null;
  const pendingPath = path.join(args.receiptsDir, `${operationId}.receipt.pending.json`);

  try {
    await client.query("begin");

    const lockRes = await client.query<{ hash64: string }>(`select hashtextextended('mas_nakit_radar:legacy_repair', 0)::text as hash64`);
    await client.query(`select pg_advisory_xact_lock(hashtextextended('mas_nakit_radar:legacy_repair', 0))`);
    const advisoryLockKey = { name: "mas_nakit_radar:legacy_repair", hash64: lockRes.rows[0].hash64 };

    const tsRes = await client.query<{ ts: string }>(
      `select ${TO_CHAR_INSTANT.replace("$COL$", "transaction_timestamp()")} as ts`,
    );
    const eventTimestamp = tsRes.rows[0].ts;
    // Same DB-clock instant, converted to its Europe/Istanbul civil date — anchors the
    // eligibility re-check to this transaction's own fixed timestamp rather than a second,
    // possibly-later Node `new Date()` call.
    const applyTodayISO = istanbulDateISO(new Date(eventTimestamp));

    // Payment + evidence drift check.
    if (inventory.archivedPayment) {
      const pRow = await client.query<{ raw: string }>(
        `select to_jsonb(t)::text as raw from public.payments t where t.id=$1 for update`,
        [inventory.archivedPayment.id],
      );
      if (pRow.rowCount !== 1 || canonicalHash(pRow.rows[0].raw) !== inventory.archivedPayment.beforeStateHash) {
        throw new Error("archived payment before-state hash sapması — repair uygulanmadı.");
      }
    }
    for (const evRow of [inventory.evidence.legacyInstanceAuditRow, inventory.evidence.archivedPaymentAuditRow]) {
      if (!evRow) continue;
      const r = await client.query<{ raw: string }>(`select to_jsonb(t)::text as raw from public.audit_logs t where t.id=$1`, [evRow.id]);
      if (r.rowCount !== 1 || canonicalHash(r.rows[0].raw) !== evRow.canonicalHash) {
        throw new Error(`kanıt audit satırı (${evRow.id}) hash sapması — repair uygulanmadı.`);
      }
    }

    // Target-level before-hash drift check for every approved entry.
    const targetByKey = new Map<string, InventoryTarget>();
    for (const t of inventory.targets) targetByKey.set(`${t.instanceId}|${t.kind}`, t);
    for (const a of approval.approvals) {
      const target = targetByKey.get(`${a.instanceId}|${a.kind}`);
      if (!target) throw new Error(`approval hedefi (${a.instanceId}/${a.kind}) inventory'de bulunamadı.`);
      if (target.kind === "archive_cascade_repair" && target.classification !== "candidate") {
        throw new Error(`approval hedefi (${a.instanceId}) inventory'de classification='${target.classification}' — yalnız candidate onaylanabilir.`);
      }
      if (target.kind === "cancellation_metadata_repair" && target.classification !== "unresolved") {
        throw new Error(`approval hedefi (${a.instanceId}) inventory'de classification='${target.classification}' — yalnız unresolved onaylanabilir.`);
      }
      const live = await client.query<{ raw: string; status: string; due_date: string; payment_id: string | null }>(
        `select to_jsonb(t)::text as raw, status, to_char(due_date,'YYYY-MM-DD') as due_date, payment_id
         from public.payment_instances t where t.id=$1 for update`,
        [a.instanceId],
      );
      if (live.rowCount !== 1 || canonicalHash(live.rows[0].raw) !== target.beforeStateHash) {
        throw new Error(`onaylı hedef (${a.instanceId}) before-state hash sapması — TÜM apply reddedildi.`);
      }
      if (target.kind === "archive_cascade_repair") {
        stage = "eligibility";
        const row = live.rows[0];
        if (!["unpaid", "planned"].includes(row.status)) {
          throw new Error(`onaylı hedef (${a.instanceId}) artık uygun değil: canlı status='${row.status}'.`);
        }
        if (row.due_date < applyTodayISO) {
          throw new Error(`onaylı hedef (${a.instanceId}) artık uygun değil: canlı due_date (${row.due_date}) < applyTodayISO (${applyTodayISO}).`);
        }
        if (!inventory.archivedPayment || row.payment_id !== inventory.archivedPayment.id) {
          throw new Error(`onaylı hedef (${a.instanceId}) artık beklenen archived payment'a bağlı değil.`);
        }
        const payLive = await client.query<{ status: string }>(`select status from public.payments where id=$1 for update`, [row.payment_id]);
        if (payLive.rowCount !== 1 || payLive.rows[0].status !== "archived") {
          throw new Error(`onaylı hedef (${a.instanceId}) için payment artık 'archived' değil.`);
        }
      }
      stage = "precondition";
    }

    // Untouched-scope PRE-condition.
    const scopeIds = inventory.archivedPayment
      ? inventory.targets.filter((t) => t.paymentId === inventory.archivedPayment!.id).map((t) => t.instanceId)
      : [];
    const approvedIds = new Set(approval.approvals.map((a) => a.instanceId));
    const untouchedInstanceIds = sortIdsDeterministically(scopeIds.filter((id) => !approvedIds.has(id)));
    const untouchedScopeBeforeHash = await fingerprintScope(client, untouchedInstanceIds);

    // Repair mutations — one linked AppliedRepairResult per target, never separate
    // parallel arrays.
    stage = "repair_update";
    const appliedRepairs: Array<{
      instanceId: string; kind: "archive_cascade_repair" | "cancellation_metadata_repair";
      auditId: string; cancelledAt: string; beforeHash: string; afterHash: string;
    }> = [];

    for (const a of approval.approvals) {
      const target = targetByKey.get(`${a.instanceId}|${a.kind}`)!;
      if (a.kind === "archive_cascade_repair") {
        const result = await cancelInstanceWithClient(client, a.instanceId, a.approvedCancelReason, {
          auditAction: "legacy_archive_cascade_repair",
          eventTimestamp,
        });
        const afterHash = await fingerprintOne(client, a.instanceId);
        appliedRepairs.push({
          instanceId: a.instanceId, kind: a.kind, auditId: result.auditId,
          cancelledAt: result.cancelledAt, beforeHash: target.beforeStateHash, afterHash,
        });
      } else {
        const result = await repairCancellationMetadataWithClient(client, a.instanceId, a.approvedCancelledAt!, a.approvedCancelReason);
        const afterHash = await fingerprintOne(client, a.instanceId);
        appliedRepairs.push({
          instanceId: a.instanceId, kind: a.kind, auditId: result.auditId,
          cancelledAt: result.cancelledAt, beforeHash: target.beforeStateHash, afterHash,
        });
      }
    }

    // Untouched-scope POST-condition.
    const untouchedScopeAfterHash = await fingerprintScope(client, untouchedInstanceIds);
    if (untouchedScopeAfterHash !== untouchedScopeBeforeHash) {
      throw new Error("untouched-scope fingerprint sapması — kapsam dışı bir satır değişti, tüm repair reddedildi.");
    }

    const receiptCore: ReceiptCore = {
      canonicalizationVersion: CANONICALIZATION_VERSION,
      operationId,
      inventoryFileSha256: hashes.inventoryFileSha256,
      approvalFileSha256: hashes.approvalFileSha256,
      backupSha256: hashes.backupSha256,
      backupReceiptSha256: hashes.backupReceiptSha256,
      gitHead: hashes.gitHead,
      databaseName: args.expectedDatabaseName,
      systemIdentifier: inventory.systemIdentifier,
      ledgerCount: inventory.ledgerCount,
      lastMigrationVersion: inventory.lastMigrationVersion,
      transactionTimestamp: eventTimestamp,
      advisoryLockKey,
      appliedRepairs: sortAppliedRepairsDeterministically(appliedRepairs),
      untouchedInstanceIds,
      untouchedScopeBeforeHash,
      untouchedScopeAfterHash,
    };
    const receiptCoreSha256 = payloadSha256(receiptCore);

    stage = "pending_write";
    writeExclusiveDurable(
      pendingPath,
      (durability) => {
        const pendingFile: PendingReceiptFile = { status: "pending", operationId, receiptCore, receiptCoreSha256, durability };
        return JSON.stringify(pendingFile, null, 2);
      },
      (text) => {
        const parsed = PendingReceiptFileSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`pending receipt kendi şemasından geçemedi: ${parsed.error.message}`);
      },
    );
    pendingFileSha256 = fileSha256(readFileSync(pendingPath));

    stage = "summary_audit_insert";
    const summaryAuditId = await writeLegacyRepairSummaryWithClient(
      client,
      {
        operationId,
        receiptCoreSha256,
        pendingFileSha256,
        inventoryFileSha256: hashes.inventoryFileSha256,
        approvalFileSha256: hashes.approvalFileSha256,
        backupSha256: hashes.backupSha256,
        backupReceiptSha256: hashes.backupReceiptSha256,
        transactionTimestamp: eventTimestamp,
        appliedRepairs: receiptCore.appliedRepairs,
        untouchedScopeAfterHash,
      },
      eventTimestamp,
    );

    stage = "commit";
    await client.query("commit");
    commitConfirmed = true;

    const committedPath = path.join(args.receiptsDir, `${operationId}.receipt.committed.json`);
    writeViaTempAndRename(
      committedPath,
      (durability) => {
        const committedFile: CommittedReceiptFile = {
          status: "committed", operationId, receiptCore, receiptCoreSha256, pendingFileSha256: pendingFileSha256!,
          summaryAuditId, summaryAuditCreatedAt: eventTimestamp, finalizationMode: "normal", durability,
        };
        return JSON.stringify(committedFile, null, 2);
      },
      (text) => {
        const parsed = CommittedReceiptFileSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`committed receipt kendi şemasından geçemedi: ${parsed.error.message}`);
      },
    );

    console.log(`Repair başarıyla commit edildi. operationId=${operationId}`);
    console.log(`  committed receipt: ${committedPath}`);
    console.log(`  uygulanan hedef sayısı: ${receiptCore.appliedRepairs.length}`);
  } catch (err) {
    if (commitConfirmed) {
      // COMMIT definitely succeeded server-side — only the committed-receipt write (or
      // something after it) failed. The repair is real; only its receipt is missing.
      console.error(`GÜVENLİK DURDURMASI: commit KESİN başarılı oldu ama committed receipt yazılamadı/tamamlanamadı.`);
      console.error(`  operationId=${operationId}`);
      console.error(`  pending receipt: ${pendingPath}`);
      console.error(`  ZORUNLU: scripts/db/legacy-repair-recover-receipt.ts --pending ${pendingPath} --expected-pending-sha256 ${pendingFileSha256} --expected-database-name ${args.expectedDatabaseName} çalıştırın.`);
      console.error(`  Hata: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    if (stage === "commit") {
      // The COMMIT call itself failed (or the connection dropped while it was in
      // flight) — whether the server actually committed before the error surfaced is
      // NOT knowable from here. No rollback is attempted or trusted, no rolled_back
      // receipt is produced, and the pending file is left untouched as the sole
      // evidence. Recovery is the only correct next step.
      console.error(`GÜVENLİK DURDURMASI: commit_outcome_unknown — COMMIT çağrısı hata verdi; sunucu tarafında gerçekten commit olup olmadığı BİLİNMİYOR.`);
      console.error(`  operationId=${operationId}`);
      console.error(`  pending receipt: ${pendingPath}  (dokunulmadı, immutable kaldı)`);
      console.error(`  ZORUNLU: scripts/db/legacy-repair-recover-receipt.ts --pending ${pendingPath} --expected-pending-sha256 ${pendingFileSha256} --expected-database-name ${args.expectedDatabaseName} çalıştırın.`);
      console.error(`  Hata: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    // Pre-commit failure: the transaction never reached COMMIT, so rollback is safe and
    // its outcome can be trusted. The two early returns above already ruled out
    // stage==="commit" here; the cast just tells TS what a closure can't infer on its
    // own about a `let` captured across a callback boundary.
    await client.query("rollback").catch(() => {});
    const failureStage = stage as Exclude<ApplyStage, "commit">;
    const rolledBackPath = path.join(args.receiptsDir, `${operationId}.receipt.rolled-back.json`);
    writeViaTempAndRename(
      rolledBackPath,
      (durability) => {
        const rolledBackFile: RolledBackReceiptFile = {
          status: "rolled_back",
          operationId,
          pendingFileSha256,
          failureStage,
          failureReason: ((err as Error).message || "bilinmeyen hata (boş mesaj)").slice(0, 500),
          durability,
        };
        return JSON.stringify(rolledBackFile, null, 2);
      },
      (text) => {
        const parsed = RolledBackReceiptFileSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`rolled-back receipt kendi şemasından geçemedi: ${parsed.error.message}`);
      },
    );
    console.error(`Repair rollback edildi (stage=${stage}): ${(err as Error).message}`);
    console.error(`  rolled-back receipt: ${rolledBackPath}`);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

async function fingerprintOne(client: PoolClient, instanceId: string): Promise<string> {
  const r = await client.query<{ raw: string }>(`select to_jsonb(t)::text as raw from public.payment_instances t where t.id=$1`, [instanceId]);
  return canonicalHash(r.rows[0].raw);
}

async function fingerprintScope(client: PoolClient, ids: string[]): Promise<string> {
  if (ids.length === 0) return canonicalHash("");
  const r = await client.query<{ raw: string }>(
    `select coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '') as raw
     from public.payment_instances t where t.id = any($1)`,
    [ids],
  );
  return canonicalHash(r.rows[0].raw);
}

main().catch((err) => {
  console.error("legacy-repair-apply beklenmedik hata ile durdu:", err);
  process.exit(1);
});
