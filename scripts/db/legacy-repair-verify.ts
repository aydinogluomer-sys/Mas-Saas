// Persistent disposable-DB test suite for P0-B Slice 5's legacy repair toolchain
// (legacy-repair-inventory.ts / -approval.ts / -apply.ts / -recover-receipt.ts /
// backup-receipt.ts). Mirrors scripts/db/transitions-verify.ts's and
// reconciliation-verify.ts's pattern exactly: throwaway DBs only, never mas_radar_dev.
// Every tool under test is invoked exactly as an operator would — as a separate `tsx`
// subprocess with explicit CLI args and DATABASE_URL — so this suite exercises the real
// fail-closed CLI surface, not an in-process shortcut.
//
// FAIL-CLOSED SAFETY GATE: this file itself does not import any src/ module at its top
// level. The one exception (legacy-repair-recover-receipt's crash-recovery scenario,
// which must replay a partial repair transaction directly) dynamically imports
// src/lib/radar/engine.ts, and only after assertSafeDisposableName() has already
// confirmed the target DB is a disposable, non-production database.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
  AppliedRepairResultSchema,
  ApprovalManifestSchema,
  CANONICALIZATION_VERSION,
  CommittedReceiptFileSchema,
  DurabilityMetadataSchema,
  InventoryManifestSchema,
  ReceiptCoreSchema,
  RolledBackReceiptFileSchema,
  attemptDirectoryFsync,
  canonicalHash,
  fileSha256,
  payloadSha256,
  sameVolume,
  sortAppliedRepairsDeterministically,
  writeExclusiveDurable,
  writeViaTempAndRename,
  type BackupReceipt,
  type DirectoryFsyncImpl,
  type InventoryManifest,
  type ReceiptCore,
} from "./legacy-repair-types";

const ROOT = process.cwd();
const CONTAINER = process.env.MAS_DB_CONTAINER ?? "mas-radar-pg";
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRATE_SCRIPT = path.join(ROOT, "scripts", "db", "migrate.ts");
const INVENTORY_SCRIPT = path.join(ROOT, "scripts", "db", "legacy-repair-inventory.ts");
const APPROVAL_SCRIPT = path.join(ROOT, "scripts", "db", "legacy-repair-approval.ts");
const APPLY_SCRIPT = path.join(ROOT, "scripts", "db", "legacy-repair-apply.ts");
const BACKUP_RECEIPT_SCRIPT = path.join(ROOT, "scripts", "db", "backup-receipt.ts");
const RECOVER_SCRIPT = path.join(ROOT, "scripts", "db", "legacy-repair-recover-receipt.ts");
const PRODUCTION_SCRIPTS = [INVENTORY_SCRIPT, APPROVAL_SCRIPT, APPLY_SCRIPT, RECOVER_SCRIPT, BACKUP_RECEIPT_SCRIPT];

const DB = "mas_radar_legacy_repair_verify";
const DB_MULTI = "mas_radar_legacy_repair_verify_multi";
const DISPOSABLE_PREFIX = "mas_radar_legacy_repair_verify";
const FORBIDDEN_DB_NAME = "mas_radar_dev";

const TMP = path.join(ROOT, "scripts", "db", "_legacy_repair_verify_tmp");

interface TestOutcome { name: string; pass: boolean; detail?: string; }
const results: TestOutcome[] = [];
function record(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** Pure predicate behind the fail-closed DB-identity gate — kept side-effect-free
 * (no process.exit) specifically so it can be unit-tested directly below, unlike
 * assertSafeDisposableName which is the process-terminating wrapper every real call
 * site uses. */
function isSafeDisposableName(name: string): boolean {
  if (name === FORBIDDEN_DB_NAME) return false;
  return name.startsWith(DISPOSABLE_PREFIX);
}
/** Fail-closed: exits immediately if the target DB is the real database, or outside this
 * script's disposable namespace — before any further setup, let alone a src/ import. */
function assertSafeDisposableName(name: string, context: string): void {
  if (name === FORBIDDEN_DB_NAME) {
    console.error(`GÜVENLİK DURDURMASI (${context}): hedef DB adı '${FORBIDDEN_DB_NAME}' — gerçek veritabanına asla dokunulmaz. Çıkış.`);
    process.exit(1);
  }
  if (!name.startsWith(DISPOSABLE_PREFIX)) {
    console.error(`GÜVENLİK DURDURMASI (${context}): hedef DB adı '${name}', beklenen disposable önek '${DISPOSABLE_PREFIX}' ile başlamıyor. Çıkış.`);
    process.exit(1);
  }
}

function docker(args: string[], opts: { input?: string | Buffer } = {}): string {
  return execFileSync("docker", args, { input: opts.input, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
}
function assertContainerReachable(): void {
  try {
    docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-q"]);
  } catch {
    console.error(`PostgreSQL konteyneri (${CONTAINER}) erişilebilir değil. Bu script onu otomatik başlatmaz.`);
    process.exit(1);
  }
}
function dropDb(db: string): void {
  docker(["exec", CONTAINER, "dropdb", "-U", "postgres", "--if-exists", db]);
}
function createDb(db: string): void {
  docker(["exec", CONTAINER, "createdb", "-U", "postgres", db]);
}
function dbUrl(db: string): string {
  return `postgres://postgres:postgres@127.0.0.1:5432/${db}`;
}
function findLatestManagedFixtureDump(): string {
  const dir = path.join(ROOT, "backups");
  const files = readdirSync(dir).filter((f) => f.startsWith("p0b-managed-baseline-") && f.endsWith(".dump")).sort();
  if (files.length === 0) throw new Error("backups/p0b-managed-baseline-*.dump bulunamadı.");
  return path.join(dir, files.at(-1)!);
}
function restoreManagedFixture(db: string): void {
  dropDb(db);
  createDb(db);
  docker(["exec", "-i", CONTAINER, "pg_restore", "-U", "postgres", "-d", db, "--no-owner", "--role=postgres"], {
    input: readFileSync(findLatestManagedFixtureDump()),
  });
}
interface RunResult { code: number; stdout: string; stderr: string; }
function runTsx(script: string, args: string[], env: Record<string, string | undefined> = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [TSX_CLI, script, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}
function runMigrateAgainstUrl(url: string): RunResult {
  return runTsx(MIGRATE_SCRIPT, [], { DATABASE_URL: url });
}

interface BackupBundle { dumpPath: string; receiptPath: string; backupSha256: string; backupReceiptSha256: string; }
function makeBackup(db: string, label: string, outDir: string): BackupBundle {
  const res = runTsx(BACKUP_RECEIPT_SCRIPT, [CONTAINER, db, label, outDir]);
  if (res.code !== 0) throw new Error(`backup-receipt başarısız (${label}): ${res.stderr}`);
  const line = res.stdout.split("\n").find((l) => l.startsWith("Backup tamam: "));
  if (!line) throw new Error(`backup-receipt çıktısında dosya yolu bulunamadı: ${res.stdout}`);
  const dumpPath = line.slice("Backup tamam: ".length).split(" (")[0];
  const receiptPath = `${dumpPath}.receipt.json`;
  return {
    dumpPath,
    receiptPath,
    backupSha256: fileSha256(readFileSync(dumpPath)),
    backupReceiptSha256: fileSha256(readFileSync(receiptPath)),
  };
}
function makeInventory(db: string, url: string, outPath: string): { inventory: InventoryManifest; sha256: string } {
  const res = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", db, "--out", outPath], { DATABASE_URL: url });
  if (res.code !== 0) throw new Error(`inventory üretimi başarısız: ${res.stderr}`);
  const bytes = readFileSync(outPath);
  return { inventory: InventoryManifestSchema.parse(JSON.parse(bytes.toString("utf8"))), sha256: fileSha256(bytes) };
}
function extractOperationId(applyStdout: string): string {
  const m = applyStdout.match(/operationId=([0-9a-f-]+)/);
  if (!m) throw new Error(`apply çıktısından operationId çıkarılamadı: ${applyStdout}`);
  return m[1];
}
function listReceiptFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
function listRolledBackReceipts(dir: string): string[] {
  return listReceiptFiles(dir).filter((f) => f.endsWith(".rolled-back.json"));
}

async function main(): Promise<void> {
  assertContainerReachable();
  assertSafeDisposableName(DB, "ana disposable DB");
  assertSafeDisposableName(DB_MULTI, "çoğulluk-koruması disposable DB");

  // ── §0 fail-closed DB-identity predicate + production-tool DDL-safety self-check ──
  record("assertSafeDisposableName: 'mas_radar_dev' kesin reddedilir", !isSafeDisposableName(FORBIDDEN_DB_NAME));
  record("assertSafeDisposableName: disposable önekli ad kabul edilir", isSafeDisposableName(DB));
  record("assertSafeDisposableName: önek dışı rastgele ad reddedilir", !isSafeDisposableName("baska_bir_veritabani"));
  {
    const violations: string[] = [];
    for (const scriptPath of PRODUCTION_SCRIPTS) {
      const source = readFileSync(scriptPath, "utf8").toLowerCase();
      if (source.includes("disable trigger") || source.includes("drop constraint") || source.includes("disable rule")) {
        violations.push(path.basename(scriptPath));
      }
    }
    record(
      "production araçlarında (inventory/approval/apply/recover/backup-receipt) hiçbir constraint/trigger disable/drop kodu yok",
      violations.length === 0,
      violations.length > 0 ? `bulunan: ${violations.join(", ")}` : undefined,
    );
  }

  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const receiptsDir = path.join(TMP, "receipts");
  mkdirSync(receiptsDir, { recursive: true });

  restoreManagedFixture(DB);
  const url = dbUrl(DB);
  const migrateRes = runMigrateAgainstUrl(url);
  if (migrateRes.code !== 0) throw new Error(`migrate başarısız: ${migrateRes.stderr}`);
  const pool = new Pool({ connectionString: url, max: 5 });

  try {
    // ── §1 inventory ──
    const inventoryPath = path.join(TMP, "inventory.json");
    const { inventory, sha256: inventoryFileSha256 } = makeInventory(DB, url, inventoryPath);
    record("inventory: genuine discovery — en az 24 candidate + 1 unresolved + 2 ineligible hedef üretti", (() => {
      const c = inventory.targets.filter((t) => t.classification === "candidate").length;
      const u = inventory.targets.filter((t) => t.classification === "unresolved").length;
      const i = inventory.targets.filter((t) => t.classification === "ineligible").length;
      return c >= 20 && u === 1 && i >= 1;
    })());
    record("inventory: unresolved hedefin proposedCancelReason'ı null (fabrikasyon yok)", (() => {
      const unresolvedTgt = inventory.targets.find((t) => t.classification === "unresolved");
      return unresolvedTgt?.proposedCancelReason === null;
    })());
    record("inventory: --expected-database-name DATABASE_URL ile uyuşmayınca reddedilir", (() => {
      const r = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", "baska_bir_db", "--out", path.join(TMP, "should-not-exist.json")], { DATABASE_URL: url });
      return r.code !== 0 && !existsSync(path.join(TMP, "should-not-exist.json"));
    })());
    record("inventory: aynı --out yolu ikinci kez yazılamaz (immutability, wx flag)", (() => {
      const r = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", DB, "--out", inventoryPath], { DATABASE_URL: url });
      return r.code !== 0;
    })());

    const candidates = inventory.targets.filter((t) => t.classification === "candidate").map((t) => t.instanceId);
    const unresolvedTarget = inventory.targets.find((t) => t.classification === "unresolved")!;
    const ineligibleTarget = inventory.targets.find((t) => t.classification === "ineligible")!;
    const [happyId1, happyId2, driftPreconditionId, driftEligibilityId, commitUnknownId, ...restCandidates] = candidates;

    // ── §2 approval ──
    const apprOut = (name: string) => path.join(TMP, `approval-${name}.json`);
    record("approval: yanlış --expected-inventory-sha256 reddedilir", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", "0".repeat(64),
        "--approve-archive-instance", happyId1, "--confirm-archive-reason", "x",
        "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", apprOut("bad-hash"),
      ]);
      return r.code !== 0 && !existsSync(apprOut("bad-hash"));
    })());
    record("approval: ineligible hedef archive olarak onaylanamaz", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-archive-instance", ineligibleTarget.instanceId, "--confirm-archive-reason", "x",
        "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", apprOut("ineligible"),
      ]);
      return r.code !== 0 && r.stderr.includes("classification") && !existsSync(apprOut("ineligible"));
    })());
    record("approval: --confirm-archive-reason eksikse reddedilir", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-archive-instance", happyId1,
        "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", apprOut("no-reason"),
      ]);
      return r.code !== 0 && !existsSync(apprOut("no-reason"));
    })());
    record("approval: --confirm-archive-timestamp-policy yanlış değerse reddedilir", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-archive-instance", happyId1, "--confirm-archive-reason", "x",
        "--confirm-archive-timestamp-policy", "yanlis_deger", "--out", apprOut("bad-policy"),
      ]);
      return r.code !== 0 && !existsSync(apprOut("bad-policy"));
    })());
    record("approval: aynı UUID iki kez onaylanamaz", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-archive-instance", happyId1, "--approve-archive-instance", happyId1,
        "--confirm-archive-reason", "x", "--confirm-archive-timestamp-policy", "apply_transaction_timestamp",
        "--out", apprOut("dup"),
      ]);
      return r.code !== 0 && !existsSync(apprOut("dup"));
    })());
    record("approval: sıfır onaylı hedefle manifest üretilmez", (() => {
      const r = runTsx(APPROVAL_SCRIPT, ["--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256, "--out", apprOut("zero")]);
      return r.code !== 0 && !existsSync(apprOut("zero"));
    })());
    record("approval: metadata onayında --confirm-timestamp proposedCancelledAt ile birebir eşleşmezse reddedilir", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-metadata-instance", unresolvedTarget.instanceId, "--reason", "x",
        "--confirm-timestamp", "2020-01-01T00:00:00.000000Z", "--out", apprOut("bad-ts"),
      ]);
      return r.code !== 0 && !existsSync(apprOut("bad-ts"));
    })());
    const happyApprovalPath = apprOut("happy");
    const happyApprRes = runTsx(APPROVAL_SCRIPT, [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approve-archive-instance", happyId1, "--approve-archive-instance", happyId2,
      "--confirm-archive-reason", "Legacy repair verify: mutlu yol",
      "--confirm-archive-timestamp-policy", "apply_transaction_timestamp",
      "--out", happyApprovalPath,
    ]);
    record("approval: mutlu yol (2 archive onayı) başarıyla üretildi", happyApprRes.code === 0, happyApprRes.stderr.slice(0, 300));
    const happyApprovalBytes = readFileSync(happyApprovalPath);
    const happyApprovalSha256 = fileSha256(happyApprovalBytes);
    const happyApproval = ApprovalManifestSchema.parse(JSON.parse(happyApprovalBytes.toString("utf8")));
    record("approval: manifest şeması + payload hash'i kendi içinde tutarlı", (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { approvedAt: _a, approvalPayloadSha256: _h, durability: _d, ...rest } = happyApproval;
      return payloadSha256(rest) === happyApproval.approvalPayloadSha256;
    })());

    // ── §2.5 canonicalizationVersion + durability on inventory/approval manifests ──
    record("inventory: canonicalizationVersion taşıyor", inventory.canonicalizationVersion === CANONICALIZATION_VERSION);
    record("approval: canonicalizationVersion taşıyor", happyApproval.canonicalizationVersion === CANONICALIZATION_VERSION);
    record("inventory: durability metadata taşıyor ve strict şemadan geçiyor (directoryFsyncAttempted=true)", (() => {
      const parsed = DurabilityMetadataSchema.safeParse(inventory.durability);
      return parsed.success && inventory.durability.directoryFsyncAttempted === true;
    })());
    record("approval: durability metadata taşıyor ve strict şemadan geçiyor (directoryFsyncAttempted=true)", (() => {
      const parsed = DurabilityMetadataSchema.safeParse(happyApproval.durability);
      return parsed.success && happyApproval.durability.directoryFsyncAttempted === true;
    })());
    record("inventory: gerçek yazım win32 full-directory-fsync olarak raporlandı (bu host)", inventory.durability.durabilityMode === "full-directory-fsync");
    record("approval: gerçek yazım win32 full-directory-fsync olarak raporlandı (bu host)", happyApproval.durability.durabilityMode === "full-directory-fsync");
    record("inventory: durable-write ile yazılıp yeniden okunarak byte/hash/schema doğrulamasından geçti (makeInventory zaten throw etmedi + dış yeniden-doğrulama)", (() => {
      const reReadBytes = readFileSync(inventoryPath);
      const reReadSha256 = fileSha256(reReadBytes);
      const reParsed = InventoryManifestSchema.safeParse(JSON.parse(reReadBytes.toString("utf8")));
      return reReadSha256 === inventoryFileSha256 && reParsed.success;
    })());
    record("approval: durable-write ile yazılıp yeniden okunarak byte/hash/schema doğrulamasından geçti", (() => {
      const reReadBytes = readFileSync(happyApprovalPath);
      const reReadSha256 = fileSha256(reReadBytes);
      const reParsed = ApprovalManifestSchema.safeParse(JSON.parse(reReadBytes.toString("utf8")));
      return reReadSha256 === happyApprovalSha256 && reParsed.success;
    })());

    // Field-shape helper for the negative canonicalizationVersion tests below — clones
    // the REAL, already-generated (and already schema-valid) inventory/approval objects
    // and mutates exactly one field, so every other field stays realistic.
    function withoutField<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
      const clone = { ...obj };
      delete clone[key];
      return clone;
    }
    record("InventoryManifestSchema: eksik canonicalizationVersion reddedilir", !InventoryManifestSchema.safeParse(withoutField(inventory, "canonicalizationVersion")).success);
    record("ApprovalManifestSchema: eksik canonicalizationVersion reddedilir", !ApprovalManifestSchema.safeParse(withoutField(happyApproval, "canonicalizationVersion")).success);
    record("InventoryManifestSchema: bilinmeyen canonicalizationVersion reddedilir", !InventoryManifestSchema.safeParse({ ...inventory, canonicalizationVersion: "project-canonical-json-v2" }).success);
    record("ApprovalManifestSchema: bilinmeyen canonicalizationVersion reddedilir", !ApprovalManifestSchema.safeParse({ ...happyApproval, canonicalizationVersion: "project-canonical-json-v2" }).success);

    // SIMULATED (schema-level, not live-reproduced — see the real durability tests above
    // and the SIMULE attemptDirectoryFsync tests further below for why this host cannot
    // organically produce EPERM/ENOSYS through the real write path): proves the artifact
    // schemas correctly ACCEPT a valid windows-best-effort durability shape when embedded,
    // i.e. the artifact CAN correctly represent that outcome if it ever occurs.
    const bestEffortDurability = { platform: "win32" as const, durabilityMode: "windows-best-effort" as const, directoryFsyncAttempted: true, directoryFsyncSupported: false, directoryFsyncErrorCode: "EPERM" };
    record("InventoryManifestSchema: SIMULE win32 best-effort durability şekli kabul edilir", InventoryManifestSchema.safeParse({ ...inventory, durability: bestEffortDurability }).success);
    record("ApprovalManifestSchema: SIMULE win32 best-effort durability şekli kabul edilir", ApprovalManifestSchema.safeParse({ ...happyApproval, durability: bestEffortDurability }).success);

    record("inventory: beklenmeyen directory hatası (nonexistent --out dizini) fail-closed reddedilir, dosya oluşmaz", (() => {
      const badOut = path.join(TMP, "nonexistent-subdir-xyz", "should-not-be-created.json");
      const r = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", DB, "--out", badOut], { DATABASE_URL: url });
      return r.code !== 0 && !existsSync(badOut);
    })());

    // Old-format inventory (pre-this-round shape: no canonicalizationVersion, no
    // durability) — matching exactly what scripts/db/legacy-repair-inventory.ts produced
    // before this correction, including the real artifact already on disk at
    // backups/legacy-repair-manifests/legacy-repair-inventory-2026-07-20T14-23-39-599Z.json
    // (sha256 82cdd01a53b59dc01970fbd07d3b5640e50d925db7fac40c12e63cf66a6b65e8, never
    // touched by this suite). Built here from the real, current inventory object with
    // both new fields stripped, so every OTHER field is realistic.
    record("apply: eski formatlı (canonicalizationVersion/durability yok) inventory dosyası şema seviyesinde reddedilir", (() => {
      const oldShapeInventory = withoutField(withoutField(inventory, "canonicalizationVersion"), "durability");
      const oldShapePath = path.join(TMP, "old-shape-inventory.json");
      const oldShapeJson = JSON.stringify(oldShapeInventory, null, 2);
      writeFileSync(oldShapePath, oldShapeJson, { encoding: "utf8", flag: "wx" });
      const oldShapeSha256 = fileSha256(Buffer.from(oldShapeJson, "utf8"));
      const parsedDirectly = InventoryManifestSchema.safeParse(oldShapeInventory);
      const r = runTsx(APPLY_SCRIPT, [
        "--inventory", oldShapePath, "--expected-inventory-sha256", oldShapeSha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", "does-not-matter.dump", "--expected-backup-sha256", "0".repeat(64),
        "--backup-receipt", "does-not-matter.receipt.json", "--expected-backup-receipt-sha256", "0".repeat(64),
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", path.join(TMP, "receipts"),
      ], { DATABASE_URL: url });
      return !parsedDirectly.success && r.code !== 0 && r.stderr.includes("strict şemadan geçemedi");
    })());

    // payload-hash policy tests: generatedAt/durability excluded, canonicalizationVersion included.
    record("payload hash: generatedAt değişse de semantic payload hash aynı kalır", (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g1, inventoryPayloadSha256: _h1, durability: _d1, ...restA } = inventory;
      const variantB = { ...inventory, generatedAt: "2020-01-01T00:00:00.000000Z" };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g2, inventoryPayloadSha256: _h2, durability: _d2, ...restB } = variantB;
      return payloadSha256(restA) === payloadSha256(restB);
    })());
    record("payload hash: canonicalizationVersion değişikliği payload hash'i değiştirir", (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g1, inventoryPayloadSha256: _h1, durability: _d1, ...restA } = inventory;
      const variantB = { ...inventory, canonicalizationVersion: "project-canonical-json-v2" };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g2, inventoryPayloadSha256: _h2, durability: _d2, ...restB } = variantB;
      return payloadSha256(restA) !== payloadSha256(restB);
    })());
    record("payload hash: durability değişikliği (dahil edilmediği için) payload hash'i DEĞİŞTİRMEZ — politika testle sabitlendi", (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g1, inventoryPayloadSha256: _h1, durability: _d1, ...restA } = inventory;
      const differentDurability = { platform: "linux" as const, durabilityMode: "full-directory-fsync" as const, directoryFsyncAttempted: true, directoryFsyncSupported: true, directoryFsyncErrorCode: null };
      const variantB = { ...inventory, durability: differentDurability };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g2, inventoryPayloadSha256: _h2, durability: _d2, ...restB } = variantB;
      return payloadSha256(restA) === payloadSha256(restB);
    })());

    // ── §3 backup-receipt ──
    const backup1 = makeBackup(DB, "verify-happy", path.join(TMP, "backups"));
    record("backup-receipt: dump + receipt üretildi, receipt.sha256 gerçek dump hash'iyle eşleşiyor", (() => {
      const receipt: BackupReceipt = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      return receipt.sha256 === backup1.backupSha256 && receipt.databaseName === DB;
    })());
    record("backup-receipt: durability metadata strict şemadan geçiyor ve directoryFsyncAttempted=true", (() => {
      const receipt: BackupReceipt = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      const parsed = DurabilityMetadataSchema.safeParse(receipt.durability);
      return parsed.success && receipt.durability.directoryFsyncAttempted === true;
    })());

    // ── §3.5 Windows durability infrastructure ──
    record("durability: gerçek attemptDirectoryFsync (win32, bu host) — 'r+' ile GERÇEK full-directory-fsync başarılı", (() => {
      const d = attemptDirectoryFsync(receiptsDir);
      return d.platform === "win32" && d.durabilityMode === "full-directory-fsync" && d.directoryFsyncSupported === true && d.directoryFsyncErrorCode === null;
    })());
    record("durability: sameVolume aynı yol için true döner", sameVolume("C:\\foo\\bar.json", "C:\\foo\\bar-2.json"));
    record("durability: sameVolume farklı sürücü harfleri için false döner", !sameVolume("C:\\foo\\bar.json", "D:\\foo\\bar.json"));

    function fakeImpl(codeToThrow: string, flagsToFail: string[] = ["r+", "r"]): DirectoryFsyncImpl {
      return {
        open: (_p, flag) => {
          if (flagsToFail.includes(flag)) {
            const err = new Error(`simulated ${codeToThrow}`) as NodeJS.ErrnoException;
            err.code = codeToThrow;
            throw err;
          }
          return 999;
        },
        fsync: () => {},
        close: () => {},
      };
    }
    // SIMULATED (not empirically reproduced on this host — this host's real 'r+' path
    // succeeds, see the real test above): proves the win32 best-effort tolerance branch
    // for EPERM and ENOSYS, and the fail-closed branch for an unexpected code (EIO),
    // by injecting a fake open/fsync implementation rather than relying on genuine OS
    // behavior this host does not exhibit.
    record("durability: SIMULE win32 EPERM (r+ ve r ikisi de) → best-effort devam eder, metadata kaydedilir", (() => {
      const d = attemptDirectoryFsync(receiptsDir, "win32", fakeImpl("EPERM"));
      return d.durabilityMode === "windows-best-effort" && d.directoryFsyncSupported === false && d.directoryFsyncErrorCode === "EPERM" && d.platform === "win32";
    })());
    record("durability: SIMULE win32 ENOSYS (r+ ve r ikisi de) → best-effort devam eder", (() => {
      const d = attemptDirectoryFsync(receiptsDir, "win32", fakeImpl("ENOSYS"));
      return d.durabilityMode === "windows-best-effort" && d.directoryFsyncErrorCode === "ENOSYS";
    })());
    record("durability: SIMULE win32 beklenmeyen EIO → fail-closed (throw)", (() => {
      try {
        attemptDirectoryFsync(receiptsDir, "win32", fakeImpl("EIO"));
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EIO";
      }
    })());
    record("durability: aynı EPERM kodu win32 DIŞINDA (linux) tolere edilmez → fail-closed (throw)", (() => {
      try {
        attemptDirectoryFsync(receiptsDir, "linux", fakeImpl("EPERM", ["r"]));
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    })());
    record("durability: 'r+' başarısız ama 'r' başarılı olursa win32'de full-directory-fsync raporlanır", (() => {
      const d = attemptDirectoryFsync(receiptsDir, "win32", fakeImpl("EPERM", ["r+"]));
      return d.durabilityMode === "full-directory-fsync" && d.directoryFsyncSupported === true;
    })());
    record("DurabilityMetadataSchema: durabilityMode='windows-best-effort' + platform='linux' tutarsızlığı reddedilir", (() => {
      return !DurabilityMetadataSchema.safeParse({
        platform: "linux", durabilityMode: "windows-best-effort",
        directoryFsyncAttempted: true, directoryFsyncSupported: false, directoryFsyncErrorCode: "EPERM",
      }).success;
    })());
    record("DurabilityMetadataSchema: directoryFsyncSupported=true + errorCode dolu tutarsızlığı reddedilir", (() => {
      return !DurabilityMetadataSchema.safeParse({
        platform: "win32", durabilityMode: "full-directory-fsync",
        directoryFsyncAttempted: true, directoryFsyncSupported: true, directoryFsyncErrorCode: "EPERM",
      }).success;
    })());
    record("durable-write: validate() reddederse writeExclusiveDurable throw eder (dosya zaten yazılmış olsa bile)", (() => {
      const p = path.join(TMP, "validate-reject-exclusive.json");
      try {
        writeExclusiveDurable(p, () => JSON.stringify({ ok: true }), () => {
          throw new Error("simulated validate rejection");
        });
        return false;
      } catch (e) {
        return (e as Error).message.includes("simulated validate rejection");
      }
    })());
    record("durable-write: validate() reddederse writeViaTempAndRename throw eder", (() => {
      const p = path.join(TMP, "validate-reject-rename.json");
      try {
        writeViaTempAndRename(p, () => JSON.stringify({ ok: true }), () => {
          throw new Error("simulated validate rejection");
        });
        return false;
      } catch (e) {
        return (e as Error).message.includes("simulated validate rejection");
      }
    })());
    record("durable-write: writeViaTempAndRename sonucu byte-hash-doğru re-read edilebilir (rename sonrası dosya gerçekten okunabilir ve doğrulanmış içerikle eşleşir)", (() => {
      const p = path.join(TMP, "reread-check.json");
      const content = JSON.stringify({ marker: "reread-check", n: 12345 });
      writeViaTempAndRename(p, () => content, (text) => {
        if (text !== content) throw new Error("reread mismatch");
      });
      return readFileSync(p, "utf8") === content;
    })());

    // ── ReceiptCoreSchema: appliedRepairs duplicate/canonical-order guards (schema-level, no DB) ──
    function makeBaseReceiptCore(appliedRepairs: unknown[]): unknown {
      return {
        canonicalizationVersion: CANONICALIZATION_VERSION,
        operationId: randomUUID(),
        inventoryFileSha256: "0".repeat(64),
        approvalFileSha256: "0".repeat(64),
        backupSha256: "0".repeat(64),
        backupReceiptSha256: "0".repeat(64),
        gitHead: "0".repeat(40),
        databaseName: DB,
        systemIdentifier: "123456789",
        ledgerCount: 29,
        lastMigrationVersion: "0029",
        transactionTimestamp: "2026-07-20T00:00:00.000000Z",
        advisoryLockKey: { name: "mas_nakit_radar:legacy_repair", hash64: "1" },
        appliedRepairs,
        untouchedInstanceIds: [],
        untouchedScopeBeforeHash: "0".repeat(64),
        untouchedScopeAfterHash: "0".repeat(64),
      };
    }
    // version=4/variant=8 nibbles are required — zod's z.uuid() enforces RFC 4122 shape,
    // not just the general xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx pattern.
    const idA = "00000000-0000-4000-8000-00000000000a";
    const idB = "00000000-0000-4000-8000-00000000000b";
    const auditA = "10000000-0000-4000-8000-00000000000a";
    const auditB = "10000000-0000-4000-8000-00000000000b";
    const repairEntry = (instanceId: string, auditId: string) => ({
      instanceId, kind: "archive_cascade_repair", auditId,
      cancelledAt: "2026-07-20T00:00:00.000000Z", beforeHash: "0".repeat(64), afterHash: "0".repeat(64),
    });
    record("AppliedRepairResultSchema: geçerli tek girdi şemadan geçer", AppliedRepairResultSchema.safeParse(repairEntry(idA, auditA)).success);
    record("ReceiptCoreSchema: appliedRepairs boşsa reddedilir", !ReceiptCoreSchema.safeParse(makeBaseReceiptCore([])).success);
    record("ReceiptCoreSchema: duplicate instanceId reddedilir", !ReceiptCoreSchema.safeParse(
      makeBaseReceiptCore([repairEntry(idA, auditA), repairEntry(idA, auditB)]),
    ).success);
    record("ReceiptCoreSchema: duplicate auditId reddedilir", !ReceiptCoreSchema.safeParse(
      makeBaseReceiptCore([repairEntry(idA, auditA), repairEntry(idB, auditA)]),
    ).success);
    record("ReceiptCoreSchema: canonical (artan instanceId) sırada olan geçerli dizi kabul edilir", ReceiptCoreSchema.safeParse(
      makeBaseReceiptCore([repairEntry(idA, auditA), repairEntry(idB, auditB)]),
    ).success);
    record("ReceiptCoreSchema: canonical OLMAYAN (ters) sıradaki dizi sessizce sıralanmaz, REDDEDİLİR", !ReceiptCoreSchema.safeParse(
      makeBaseReceiptCore([repairEntry(idB, auditB), repairEntry(idA, auditA)]),
    ).success);
    record("sortAppliedRepairsDeterministically: ters sırayı canonical sıraya döndürür", (() => {
      const sorted = sortAppliedRepairsDeterministically([repairEntry(idB, auditB), repairEntry(idA, auditA)]);
      return sorted[0].instanceId === idA && sorted[1].instanceId === idB;
    })());

    // ── §4 apply ──
    const commonApplyArgs = (approvalPath: string, approvalSha: string, backup: BackupBundle) => [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approval", approvalPath, "--expected-approval-sha256", approvalSha,
      "--backup", backup.dumpPath, "--expected-backup-sha256", backup.backupSha256,
      "--backup-receipt", backup.receiptPath, "--expected-backup-receipt-sha256", backup.backupReceiptSha256,
      "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir,
    ];

    const dryRunRes = runTsx(APPLY_SCRIPT, commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1), { DATABASE_URL: url });
    record("apply: --apply verilmeden dry-run başarılı, hiçbir receipt yazılmadı", dryRunRes.code === 0 && listReceiptFiles(receiptsDir).length === 0, dryRunRes.stderr.slice(0, 300));

    record("apply: yanlış --expected-database-name reddedilir", (() => {
      const args = commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1).map((a) => (a === DB ? "yanlis_db_adi" : a));
      const r = runTsx(APPLY_SCRIPT, args, { DATABASE_URL: url });
      return r.code !== 0;
    })());
    record("apply: yanlış --expected-backup-sha256 reddedilir", (() => {
      const args = [...commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1)];
      args[args.indexOf("--expected-backup-sha256") + 1] = "0".repeat(64);
      const r = runTsx(APPLY_SCRIPT, args, { DATABASE_URL: url });
      return r.code !== 0 && listReceiptFiles(receiptsDir).length === 0;
    })());
    record("apply: yanlış --expected-backup-receipt-sha256 reddedilir", (() => {
      const args = [...commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1)];
      args[args.indexOf("--expected-backup-receipt-sha256") + 1] = "0".repeat(64);
      const r = runTsx(APPLY_SCRIPT, args, { DATABASE_URL: url });
      return r.code !== 0;
    })());

    // approval bound to a DIFFERENT inventory file → rejected even with correct byte hashes.
    const inventory2Path = path.join(TMP, "inventory2.json");
    const { sha256: inventory2Sha256 } = makeInventory(DB, url, inventory2Path);
    record("apply: approval başka bir inventory dosyasına bağlıysa (inventoryFileSha256 uyuşmazlığı) reddedilir", (() => {
      const r = runTsx(APPLY_SCRIPT, [
        "--inventory", inventory2Path, "--expected-inventory-sha256", inventory2Sha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", backup1.dumpPath, "--expected-backup-sha256", backup1.backupSha256,
        "--backup-receipt", backup1.receiptPath, "--expected-backup-receipt-sha256", backup1.backupReceiptSha256,
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("başka bir inventory");
    })());

    // freshness ordering: a backup taken BEFORE the approval it's paired with.
    record("apply: approval, ilişkili backup'tan sonra üretilmişse (tazelik sırası) reddedilir", (() => {
      const earlyBackup = makeBackup(DB, "verify-early", path.join(TMP, "backups-early"));
      const laterApprovalPath = apprOut("later-than-backup");
      const r0 = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-archive-instance", restCandidates[0], "--confirm-archive-reason", "x",
        "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", laterApprovalPath,
      ]);
      if (r0.code !== 0) return false;
      const laterApprovalSha = fileSha256(readFileSync(laterApprovalPath));
      const r = runTsx(APPLY_SCRIPT, commonApplyArgs(laterApprovalPath, laterApprovalSha, earlyBackup), { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("tazelik sırası");
    })());

    // freshness window: a syntactically-valid but stale backup receipt (same real dump,
    // hand-crafted old backupCompletedDbTimestamp) must be rejected once connected to the DB.
    record("apply: 30 dakikayı aşan (bayat) backup receipt reddedilir", (() => {
      const staleReceipt: BackupReceipt = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      const stale = { ...staleReceipt, backupStartedDbTimestamp: "2020-01-01T00:00:00.000000Z", backupCompletedDbTimestamp: "2020-01-01T00:00:05.000000Z" };
      const stalePath = path.join(TMP, "stale.receipt.json");
      writeFileSync(stalePath, JSON.stringify(stale, null, 2));
      const staleSha256 = fileSha256(readFileSync(stalePath));
      const args = [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", backup1.dumpPath, "--expected-backup-sha256", backup1.backupSha256,
        "--backup-receipt", stalePath, "--expected-backup-receipt-sha256", staleSha256,
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir,
      ];
      const r = runTsx(APPLY_SCRIPT, args, { DATABASE_URL: url });
      return r.code !== 0;
    })());

    // ledger drift: DB's schema_migrations changed since inventory was generated.
    {
      await pool.query(
        `insert into public.schema_migrations(version,name,checksum,applied_by)
         values ('9999','legacy-repair-verify-ledger-drift','deadbeef','legacy-repair-verify')
         on conflict do nothing`,
      );
      const r = runTsx(APPLY_SCRIPT, commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1), { DATABASE_URL: url });
      await pool.query(`delete from public.schema_migrations where version='9999'`);
      record("apply: inventory alındıktan sonra ledger değişmişse (canlı ledger sapması) reddedilir", r.code !== 0 && r.stderr.includes("ledger"));
    }

    // ── happy-path real apply, with full receipt/audit verification ──
    const applyRes = runTsx(APPLY_SCRIPT, [...commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1), "--apply"], { DATABASE_URL: url });
    record("apply: mutlu yol --apply başarıyla commit edildi", applyRes.code === 0, applyRes.stderr.slice(0, 500));
    const happyOperationId = extractOperationId(applyRes.stdout);
    const happyCommittedPath = path.join(receiptsDir, `${happyOperationId}.receipt.committed.json`);
    const happyPendingPath = path.join(receiptsDir, `${happyOperationId}.receipt.pending.json`);
    record("apply: pending + committed receipt dosyaları var", existsSync(happyPendingPath) && existsSync(happyCommittedPath));
    if (existsSync(happyCommittedPath)) {
      const committed = CommittedReceiptFileSchema.parse(JSON.parse(readFileSync(happyCommittedPath, "utf8")));
      const realPendingSha256 = fileSha256(readFileSync(happyPendingPath));
      record("apply: committed.pendingFileSha256 gerçek pending byte hash'iyle eşleşiyor", committed.pendingFileSha256 === realPendingSha256);
      record("apply: committed.finalizationMode === 'normal'", committed.finalizationMode === "normal");
      record("apply: committed.durability strict şemadan geçiyor", DurabilityMetadataSchema.safeParse(committed.durability).success);
      record("apply: receiptCore.lastMigrationVersion === '0029'", committed.receiptCore.lastMigrationVersion === "0029");
      record("apply: receiptCore.ledgerCount === 29", committed.receiptCore.ledgerCount === 29);
      record("apply: receiptCore.appliedRepairs iki hedefi içeriyor, canonical sırada", (() => {
        const ids = committed.receiptCore.appliedRepairs.map((r) => r.instanceId);
        return ids.length === 2 && [...ids].sort().join() === ids.join();
      })());
      const summary = await pool.query<{ id: string; after_data: { pendingFileSha256?: string } }>(
        `select id, after_data from public.audit_logs where action='legacy_repair_summary' and after_data->>'operationId'=$1`,
        [happyOperationId],
      );
      record("apply: DB'de tam 1 legacy_repair_summary satırı var", summary.rowCount === 1);
      record("apply: summary.id === committed.summaryAuditId", summary.rows[0]?.id === committed.summaryAuditId);
      const instRows = await pool.query<{ status: string; cancel_reason: string | null }>(
        `select status, cancel_reason from public.payment_instances where id = any($1)`,
        [[happyId1, happyId2]],
      );
      record("apply: onaylı 2 hedef gerçekten cancelled + doğru reason", instRows.rows.every((r) => r.status === "cancelled" && r.cancel_reason === "Legacy repair verify: mutlu yol"));
      const untouched = await pool.query<{ status: string }>(`select status from public.payment_instances where id=$1`, [driftPreconditionId]);
      record("apply: onaylanmamış diğer adaylar dokunulmamış", ["unpaid", "planned"].includes(untouched.rows[0].status));
    }

    // ── precondition-drift rollback: an approved-but-unrelated row mutated between
    // inventory and apply — the row's own hash no longer matches. ──
    const driftApprovalPath = apprOut("drift-precondition");
    const driftApprRes = runTsx(APPROVAL_SCRIPT, [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approve-archive-instance", driftPreconditionId, "--confirm-archive-reason", "x",
      "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", driftApprovalPath,
    ]);
    record("drift testi: precondition approval üretildi", driftApprRes.code === 0);
    const driftBackup = makeBackup(DB, "verify-drift-precondition", path.join(TMP, "backups-drift-precondition"));
    const rolledBackBeforePrecondition = new Set(listRolledBackReceipts(receiptsDir));
    await pool.query(`update public.payment_instances set due_date = due_date - interval '365 days' where id=$1`, [driftPreconditionId]);
    const driftRes = runTsx(APPLY_SCRIPT, [
      ...commonApplyArgs(driftApprovalPath, fileSha256(readFileSync(driftApprovalPath)), driftBackup), "--apply",
    ], { DATABASE_URL: url });
    record("apply: satır hash sapması (precondition) apply'ı reddetti", driftRes.code !== 0);
    const newPreconditionReceipts = listRolledBackReceipts(receiptsDir).filter((f) => !rolledBackBeforePrecondition.has(f));
    const preconditionRolledBack = newPreconditionReceipts.length === 1
      ? RolledBackReceiptFileSchema.parse(JSON.parse(readFileSync(path.join(receiptsDir, newPreconditionReceipts[0]), "utf8")))
      : null;
    record(
      "apply: precondition sapması için failureStage='precondition' rolled-back receipt üretildi (pendingFileSha256=null, durability şemadan geçiyor)",
      preconditionRolledBack?.failureStage === "precondition"
        && preconditionRolledBack.pendingFileSha256 === null
        && DurabilityMetadataSchema.safeParse(preconditionRolledBack.durability).success,
    );
    const afterDrift = await pool.query<{ status: string }>(`select status from public.payment_instances where id=$1`, [driftPreconditionId]);
    record("apply: precondition sapmasında hedef satır cancelled OLMADI (rollback gerçek)", afterDrift.rows[0].status !== "cancelled");

    // ── COMMIT-OUTCOME-UNKNOWN: a DEFERRABLE INITIALLY DEFERRED constraint trigger on
    // audit_logs raises unconditionally — deferred, so every INSERT inside the repair
    // transaction (including the summary-audit row) succeeds immediately, but the
    // deferred check fires exactly at COMMIT time, making the real COMMIT call itself
    // fail with a genuine Postgres error. This is the real, unmodified apply.ts
    // subprocess — not a mock — hitting the exact "commit_outcome_unknown" code path.
    // MUST run before the parent-payment-drift test below: that test's un-archive/
    // re-archive dance changes the payment row's updated_at (a generic trigger, not the
    // archive-immutability one), permanently invalidating inventory.archivedPayment's
    // original beforeStateHash for the rest of this process — which would make every
    // later archive_cascade_repair apply (including this one) fail at the EARLIER
    // payment-hash precondition check instead of ever reaching COMMIT. ──
    const commitUnknownApprovalPath = apprOut("commit-unknown");
    const commitUnknownApprRes = runTsx(APPROVAL_SCRIPT, [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approve-archive-instance", commitUnknownId, "--confirm-archive-reason", "x",
      "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", commitUnknownApprovalPath,
    ]);
    record("commit-outcome-unknown testi: approval üretildi", commitUnknownApprRes.code === 0);
    const commitUnknownBackup = makeBackup(DB, "verify-commit-unknown", path.join(TMP, "backups-commit-unknown"));
    await pool.query(`
      create or replace function public.verify_force_commit_failure() returns trigger language plpgsql as $f$
      begin
        raise exception 'legacy-repair-verify: simulated commit-time failure (deferred constraint trigger)';
      end $f$;
    `);
    await pool.query(`
      create constraint trigger verify_force_commit_failure_trigger
        after insert on public.audit_logs
        deferrable initially deferred
        for each row execute function public.verify_force_commit_failure()
    `);
    let commitUnknownPendingPath: string | null = null;
    try {
      const beforeFiles = new Set(listReceiptFiles(receiptsDir));
      const commitUnknownRes = runTsx(APPLY_SCRIPT, [
        ...commonApplyArgs(commitUnknownApprovalPath, fileSha256(readFileSync(commitUnknownApprovalPath)), commitUnknownBackup), "--apply",
      ], { DATABASE_URL: url });
      record("apply: COMMIT çağrısı gerçekten başarısız oldu (exit != 0)", commitUnknownRes.code !== 0);
      record("apply: stderr 'commit_outcome_unknown' içeriyor", commitUnknownRes.stderr.includes("commit_outcome_unknown"), commitUnknownRes.stderr.slice(0, 400));
      record("apply: stderr rollback VARSAYILDIĞINI iddia etmiyor ('rollback edildi' YOK)", !commitUnknownRes.stderr.includes("rollback edildi"));
      const newFiles = listReceiptFiles(receiptsDir).filter((f) => !beforeFiles.has(f));
      record("apply: sadece pending receipt yazıldı (rolled-back YOK, committed YOK)", (
        newFiles.length === 1 && newFiles[0].endsWith(".receipt.pending.json")
      ), `yeni dosyalar: ${newFiles.join(", ")}`);
      const commitUnknownOperationId = newFiles.length === 1 ? newFiles[0].split(".")[0] : null;
      commitUnknownPendingPath = commitUnknownOperationId ? path.join(receiptsDir, `${commitUnknownOperationId}.receipt.pending.json`) : null;
      record("apply: pending dosyası immutable kaldı (hâlâ mevcut, silinmedi)", Boolean(commitUnknownPendingPath && existsSync(commitUnknownPendingPath)));

      if (commitUnknownPendingPath) {
        const targetAfter = await pool.query<{ status: string }>(`select status from public.payment_instances where id=$1`, [commitUnknownId]);
        record("apply: sunucu deferred trigger nedeniyle GERÇEKTEN rollback etti (hedef satır cancelled DEĞİL)", targetAfter.rows[0].status !== "cancelled");

        // Recovery against this pending file: since Postgres genuinely rolled back the
        // whole transaction (deferred-check failure at COMMIT auto-aborts), there is no
        // legacy_repair_summary row — recovery must independently arrive at "unresolved",
        // never fabricating a committed receipt just because a pending file exists.
        const pendingSha = fileSha256(readFileSync(commitUnknownPendingPath));
        const recoverRes = runTsx(RECOVER_SCRIPT, [
          "--pending", commitUnknownPendingPath, "--expected-pending-sha256", pendingSha, "--expected-database-name", DB,
        ], { DATABASE_URL: url });
        record("recovery: commit_outcome_unknown pending'i için DB kanıtı yok → ÇÖZÜLEMEDİ (committed üretilmez)", (
          recoverRes.code !== 0 && recoverRes.stderr.includes("ÇÖZÜLEMEDİ")
          && !existsSync(path.join(receiptsDir, `${commitUnknownOperationId}.receipt.committed.json`))
        ));
      }
    } finally {
      await pool.query(`drop trigger if exists verify_force_commit_failure_trigger on public.audit_logs`);
      await pool.query(`drop function if exists public.verify_force_commit_failure()`);
    }

    // ── parent-payment drift rollback: target instance row itself untouched, but its
    // PARENT payment was un-archived out of band. 0024's payments_archived_immutability
    // trigger AND 0023's payments_archive_consistency check constraint together make
    // un-archiving a payment genuinely impossible through any application path — disabling
    // both for this one connection is the only way to construct the scenario at all.
    //
    // This empirically resolved a real question about apply.ts's own layering: the
    // transaction's payment-level hash check (comparing the archived payment's FULL row
    // against inventory.archivedPayment.beforeStateHash) runs BEFORE the per-target loop,
    // so it catches this exact drift first, at failureStage='precondition' — the per-target
    // eligibility block's own `payments.status='archived'` re-check never gets a chance to
    // fire here. That re-check is not dead code, though: it is the only thing that would
    // still catch this same drift if the earlier payment-level hash check were ever
    // weakened or removed in a future change — intentional defense in depth, verified here
    // indirectly via the failureStage this scenario actually produces today.
    //
    // This is also, deliberately, the LAST test in this suite to touch the archived
    // payment's row: restoring status='archived' afterward does not restore updated_at,
    // so inventory.archivedPayment.beforeStateHash is permanently stale for this process
    // from here on — nothing after this point may rely on it matching live state again.
    const eligApprovalPath = apprOut("drift-parent-payment");
    const eligApprRes = runTsx(APPROVAL_SCRIPT, [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approve-archive-instance", driftEligibilityId, "--confirm-archive-reason", "x",
      "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", eligApprovalPath,
    ]);
    record("drift testi: parent-payment approval üretildi", eligApprRes.code === 0);
    const eligBackup = makeBackup(DB, "verify-drift-parent-payment", path.join(TMP, "backups-drift-parent-payment"));
    await pool.query(`alter table public.payments disable trigger payments_archived_immutability`);
    await pool.query(`alter table public.payments drop constraint payments_archive_consistency`);
    try {
      await pool.query(`update public.payments set status='active' where id=$1`, [inventory.archivedPayment!.id]);
      const rolledBackBeforeElig = new Set(listRolledBackReceipts(receiptsDir));
      const eligRes = runTsx(APPLY_SCRIPT, [
        ...commonApplyArgs(eligApprovalPath, fileSha256(readFileSync(eligApprovalPath)), eligBackup), "--apply",
      ], { DATABASE_URL: url });
      record("apply: parent payment un-archive edilince apply'ı reddetti", eligRes.code !== 0);
      const newEligReceipts = listRolledBackReceipts(receiptsDir).filter((f) => !rolledBackBeforeElig.has(f));
      const eligRolledBack = newEligReceipts.length === 1
        ? RolledBackReceiptFileSchema.parse(JSON.parse(readFileSync(path.join(receiptsDir, newEligReceipts[0]), "utf8")))
        : null;
      record(
        "apply: parent-payment sapması için failureStage='precondition' rolled-back receipt üretildi (payment-level hash kontrolü, per-target eligibility'den ÖNCE yakalıyor)",
        eligRolledBack?.failureStage === "precondition" && eligRolledBack.pendingFileSha256 === null,
      );
      await pool.query(`update public.payments set status='archived' where id=$1`, [inventory.archivedPayment!.id]);
    } finally {
      await pool.query(
        `alter table public.payments add constraint payments_archive_consistency check (
           (status = 'archived') = (archived_at is not null)
           and (archived_at is not null) = (archive_reason is not null)
           and (archived_at is not null) = (archived_by_label is not null)
         ) not valid`,
      );
      await pool.query(`alter table public.payments enable trigger payments_archived_immutability`);
    }
    const afterElig = await pool.query<{ status: string }>(`select status from public.payment_instances where id=$1`, [driftEligibilityId]);
    record("apply: parent-payment sapmasında hedef satır cancelled OLMADI (rollback gerçek)", afterElig.rows[0].status !== "cancelled");

    // ── §5 recover-receipt ──
    // report mode against the happy-path pending file.
    const reportRes = runTsx(RECOVER_SCRIPT, ["--pending", happyPendingPath, "--expected-database-name", DB], { DATABASE_URL: url });
    record("recover: rapor modu başarılı, committed üretmedi", reportRes.code === 0 && reportRes.stdout.includes("RAPOR MODU"));
    record("recover: zaten normal commit edilmiş operasyon için tam recovery reddedilir", (() => {
      const r = runTsx(RECOVER_SCRIPT, [
        "--pending", happyPendingPath, "--expected-pending-sha256", fileSha256(readFileSync(happyPendingPath)),
        "--expected-database-name", DB,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("finalizationMode='normal'");
    })());

    // true crash-recovery: manually replay apply.ts's transaction body through COMMIT,
    // deliberately never writing a committed receipt (the exact artifact a real crash
    // between `commit` and the committed-receipt write would leave behind). Built here
    // (rather than after the ledger-mismatch tests below) specifically so those tests
    // have a pending file with NO existing committed receipt to test against —
    // happyPendingPath already has one (finalizationMode='normal'), which would trip
    // recovery's own "already normal" pre-check before ever reaching the ledger
    // comparison, masking the very thing being tested.
    const crashId = restCandidates[1];
    const crashTarget = inventory.targets.find((t) => t.instanceId === crashId)!;
    const { cancelInstanceWithClient, writeLegacyRepairSummaryWithClient } = await import("../../src/lib/radar/engine");
    const crashClient = await pool.connect();
    const crashOperationId = randomUUID();
    const crashPendingPath = path.join(receiptsDir, `${crashOperationId}.receipt.pending.json`);
    try {
      await crashClient.query("begin");
      const lockRes = await crashClient.query<{ hash64: string }>(`select hashtextextended('mas_nakit_radar:legacy_repair', 0)::text as hash64`);
      await crashClient.query(`select pg_advisory_xact_lock(hashtextextended('mas_nakit_radar:legacy_repair', 0))`);
      const tsRes = await crashClient.query<{ ts: string }>(`select to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts`);
      const eventTimestamp = tsRes.rows[0].ts;
      const cancelResult = await cancelInstanceWithClient(crashClient, crashId, "Recovery crash simülasyonu", {
        auditAction: "legacy_archive_cascade_repair",
        eventTimestamp,
      });
      const afterRow = await crashClient.query<{ raw: string }>(`select to_jsonb(t)::text as raw from public.payment_instances t where t.id=$1`, [crashId]);
      const receiptCore: ReceiptCore = {
        canonicalizationVersion: CANONICALIZATION_VERSION,
        operationId: crashOperationId,
        inventoryFileSha256, approvalFileSha256: fileSha256(readFileSync(driftApprovalPath)),
        backupSha256: backup1.backupSha256, backupReceiptSha256: backup1.backupReceiptSha256,
        gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        databaseName: DB, systemIdentifier: inventory.systemIdentifier, ledgerCount: inventory.ledgerCount,
        lastMigrationVersion: inventory.lastMigrationVersion,
        transactionTimestamp: eventTimestamp,
        advisoryLockKey: { name: "mas_nakit_radar:legacy_repair", hash64: lockRes.rows[0].hash64 },
        appliedRepairs: sortAppliedRepairsDeterministically([{
          instanceId: crashId, kind: "archive_cascade_repair", auditId: cancelResult.auditId,
          cancelledAt: cancelResult.cancelledAt, beforeHash: crashTarget.beforeStateHash, afterHash: canonicalHash(afterRow.rows[0].raw),
        }]),
        untouchedInstanceIds: [], untouchedScopeBeforeHash: canonicalHash(""), untouchedScopeAfterHash: canonicalHash(""),
      };
      const receiptCoreSha256 = payloadSha256(receiptCore);
      writeExclusiveDurable(
        crashPendingPath,
        (durability) => JSON.stringify({ status: "pending", operationId: crashOperationId, receiptCore, receiptCoreSha256, durability }, null, 2),
        () => {},
      );
      const pendingFileSha256 = fileSha256(readFileSync(crashPendingPath));
      await writeLegacyRepairSummaryWithClient(crashClient, {
        operationId: crashOperationId, receiptCoreSha256, pendingFileSha256,
        inventoryFileSha256, approvalFileSha256: receiptCore.approvalFileSha256,
        backupSha256: backup1.backupSha256, backupReceiptSha256: backup1.backupReceiptSha256,
        transactionTimestamp: eventTimestamp, appliedRepairs: receiptCore.appliedRepairs,
        untouchedScopeAfterHash: receiptCore.untouchedScopeAfterHash,
      }, eventTimestamp);
      await crashClient.query("commit");
    } finally {
      crashClient.release();
    }
    const crashPendingSha256 = fileSha256(readFileSync(crashPendingPath));

    // ledgerCount / lastMigrationVersion recovery checks — INDEPENDENT of each other.
    // Uses crashPendingPath (no committed receipt exists for it yet) rather than
    // happyPendingPath, which already has one and would trip the "already normal"
    // pre-check before ever reaching the ledger comparison.
    // Version '0000' is lower than every real version, so max(version) stays '0029'
    // while count increases by exactly one — isolates a ledgerCount-only mismatch.
    const ledgerCountOnlyRejected = await withTempLedgerRow(pool, "0000", () => {
      const r = runTsx(RECOVER_SCRIPT, [
        "--pending", crashPendingPath, "--expected-pending-sha256", crashPendingSha256,
        "--expected-database-name", DB,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("ledgerCount");
    });
    record("recover: sadece ledgerCount canlıdan farklıysa (lastMigrationVersion aynı) reddedilir", ledgerCountOnlyRejected);

    // Swap '0029' for '0030' (delete one, insert one) — net count unchanged, but
    // max(version) changes — isolates a lastMigrationVersion-only mismatch.
    await pool.query(`delete from public.schema_migrations where version='0029'`);
    await pool.query(`insert into public.schema_migrations(version,name,checksum,applied_by) values ('0030','legacy-repair-verify-version-swap','deadbeef','legacy-repair-verify')`);
    const lastVersionRes = runTsx(RECOVER_SCRIPT, [
      "--pending", crashPendingPath, "--expected-pending-sha256", crashPendingSha256,
      "--expected-database-name", DB,
    ], { DATABASE_URL: url });
    await pool.query(`delete from public.schema_migrations where version='0030'`);
    await pool.query(`insert into public.schema_migrations(version,name,checksum,applied_by) values ('0029','restored','deadbeef','legacy-repair-verify')`);
    record(
      "recover: sadece lastMigrationVersion canlıdan farklıysa (ledgerCount aynı) reddedilir",
      lastVersionRes.code !== 0 && lastVersionRes.stderr.includes("lastMigrationVersion"),
    );

    const recoverRes = runTsx(RECOVER_SCRIPT, [
      "--pending", crashPendingPath, "--expected-pending-sha256", crashPendingSha256, "--expected-database-name", DB,
    ], { DATABASE_URL: url });
    record("recover: çökme sonrası tam recovery başarılı", recoverRes.code === 0, recoverRes.stderr.slice(0, 300));
    const recoveredPath = path.join(receiptsDir, `${crashOperationId}.receipt.committed.json`);
    if (existsSync(recoveredPath)) {
      const recovered = CommittedReceiptFileSchema.parse(JSON.parse(readFileSync(recoveredPath, "utf8")));
      record("recover: recovered.finalizationMode === 'recovered'", recovered.finalizationMode === "recovered");
      record("recover: recovered.durability strict şemadan geçiyor", DurabilityMetadataSchema.safeParse(recovered.durability).success);
    } else {
      record("recover: recovered.finalizationMode === 'recovered'", false, "committed dosya yazılmadı");
    }
    const recoverAgainRes = runTsx(RECOVER_SCRIPT, [
      "--pending", crashPendingPath, "--expected-pending-sha256", crashPendingSha256, "--expected-database-name", DB,
    ], { DATABASE_URL: url });
    record("recover: tekrar çalıştırıldığında idempotent (yine başarılı)", recoverAgainRes.code === 0);

    // unresolved: pending with no matching DB evidence at all.
    const ghostOperationId = randomUUID();
    const ghostPendingPath = path.join(receiptsDir, `${ghostOperationId}.receipt.pending.json`);
    const ghostCore: ReceiptCore = {
      canonicalizationVersion: CANONICALIZATION_VERSION,
      operationId: ghostOperationId,
      inventoryFileSha256, approvalFileSha256: happyApprovalSha256,
      backupSha256: backup1.backupSha256, backupReceiptSha256: backup1.backupReceiptSha256,
      gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      databaseName: DB, systemIdentifier: inventory.systemIdentifier, ledgerCount: inventory.ledgerCount,
      lastMigrationVersion: inventory.lastMigrationVersion,
      transactionTimestamp: "2026-01-01T00:00:00.000000Z",
      advisoryLockKey: { name: "mas_nakit_radar:legacy_repair", hash64: "1" },
      appliedRepairs: [{
        instanceId: idA, kind: "archive_cascade_repair", auditId: auditA,
        cancelledAt: "2026-01-01T00:00:00.000000Z", beforeHash: "0".repeat(64), afterHash: "0".repeat(64),
      }],
      untouchedInstanceIds: [], untouchedScopeBeforeHash: canonicalHash(""), untouchedScopeAfterHash: canonicalHash(""),
    };
    const ghostCoreSha256 = payloadSha256(ghostCore);
    writeExclusiveDurable(
      ghostPendingPath,
      (durability) => JSON.stringify({ status: "pending", operationId: ghostOperationId, receiptCore: ghostCore, receiptCoreSha256: ghostCoreSha256, durability }, null, 2),
      () => {},
    );
    const ghostSha256 = fileSha256(readFileSync(ghostPendingPath));
    const ghostRes = runTsx(RECOVER_SCRIPT, [
      "--pending", ghostPendingPath, "--expected-pending-sha256", ghostSha256, "--expected-database-name", DB,
    ], { DATABASE_URL: url });
    record("recover: kanıtsız (hayalet) operationId ÇÖZÜLEMEDİ ile reddedildi (exit != 0)", ghostRes.code !== 0);
    record("recover: hayalet reddediliş mesajı 'ÇÖZÜLEMEDİ' içeriyor", ghostRes.stderr.includes("ÇÖZÜLEMEDİ"), ghostRes.stderr.slice(0, 200));
    record("recover: hayalet için committed dosya YAZILMADI", !existsSync(path.join(receiptsDir, `${ghostOperationId}.receipt.committed.json`)));

    // ── §6 (separate DB) inventory multiplicity guards ──
    assertSafeDisposableName(DB_MULTI, "çoğulluk-koruması disposable DB");
    restoreManagedFixture(DB_MULTI);
    const urlMulti = dbUrl(DB_MULTI);
    const migrateMultiRes = runMigrateAgainstUrl(urlMulti);
    if (migrateMultiRes.code !== 0) throw new Error(`multi-DB migrate başarısız: ${migrateMultiRes.stderr}`);

    {
      const poolCancelled = new Pool({ connectionString: urlMulti, max: 2 });
      try {
        // 0026's payment_instances_cancel_consistency check constraint (NOT VALID —
        // tolerates the one pre-existing legacy row, but enforced for every write going
        // forward) blocks creating a SECOND such row through any normal path, by design.
        // Dropping it for this one write is the only way to construct this genuine-
        // discovery multiplicity scenario at all; it is never re-added since this DB copy
        // is discarded right after.
        await poolCancelled.query(`alter table public.payment_instances drop constraint payment_instances_cancel_consistency`);
        await poolCancelled.query(
          `update public.payment_instances set status='cancelled', cancelled_at=null, cancel_reason=null
           where id = (select id from public.payment_instances where status not in ('cancelled') limit 1)`,
        );
        const cancelledNullCount = await poolCancelled.query<{ n: string }>(
          `select count(*)::text as n from public.payment_instances where status='cancelled' and (cancelled_at is null or cancel_reason is null)`,
        );
        record("multiplicity test kurulumu: artık 2 metadata-eksik cancelled satır var", cancelledNullCount.rows[0].n === "2", cancelledNullCount.rows[0].n);
      } finally {
        await poolCancelled.end();
      }
      const multiRes = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", DB_MULTI, "--out", path.join(TMP, "multi-cancelled-inventory.json")], { DATABASE_URL: urlMulti });
      record("inventory: birden fazla metadata-eksik cancelled satır bulununca yüksek sesle durur", multiRes.code !== 0 && multiRes.stderr.includes("Beklenmedik durum"));
    }

    {
      restoreManagedFixture(DB_MULTI);
      const migrateAgainRes = runMigrateAgainstUrl(urlMulti);
      if (migrateAgainRes.code !== 0) throw new Error(`multi-DB (archived-payment senaryosu) migrate başarısız: ${migrateAgainRes.stderr}`);
      const poolArchived = new Pool({ connectionString: urlMulti, max: 2 });
      try {
        // Second archived payment — no trigger/constraint bypass needed: transitioning a
        // still-active payment INTO archived for the first time is a normal, allowed write
        // (the immutability trigger only locks rows that are ALREADY archived).
        await poolArchived.query(
          `update public.payments set status='archived', archived_at=now(), archive_reason='legacy-repair-verify: multiplicity testi', archived_by_label='legacy-repair-verify'
           where id = (select id from public.payments where status <> 'archived' limit 1)`,
        );
        const archivedCount = await poolArchived.query<{ n: string }>(`select count(*)::text as n from public.payments where status='archived'`);
        record("multiplicity test kurulumu: artık 2 archived payment var", archivedCount.rows[0].n === "2", archivedCount.rows[0].n);
      } finally {
        await poolArchived.end();
      }
      const multiArchivedRes = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", DB_MULTI, "--out", path.join(TMP, "multi-archived-inventory.json")], { DATABASE_URL: urlMulti });
      record("inventory: birden fazla archived payment bulununca yüksek sesle durur", multiArchivedRes.code !== 0 && multiArchivedRes.stderr.includes("Beklenmedik durum"));
    }
  } finally {
    await pool.end();
    dropDb(DB);
    dropDb(DB_MULTI);
    rmSync(TMP, { recursive: true, force: true });
  }

  console.log("\n=== Özet ===");
  let pass = 0;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
    if (r.pass) pass++;
  }
  console.log(`\n${pass}/${results.length} test geçti`);
  process.exit(pass === results.length ? 0 : 1);
}

/** Inserts a schema_migrations row with a version LOWER than every real applied
 * version (so max(version) / lastMigrationVersion is untouched) purely to bump
 * ledgerCount by exactly one — isolates a "ledgerCount differs" scenario from a
 * "lastMigrationVersion differs" one, which a plain top-of-ledger insert cannot do
 * (that changes both at once). Always removes the row afterward, success or failure. */
async function withTempLedgerRow<T>(pool: Pool, version: string, fn: () => T): Promise<T> {
  await pool.query(
    `insert into public.schema_migrations(version,name,checksum,applied_by) values ($1,'legacy-repair-verify-ledgercount-only','deadbeef','legacy-repair-verify') on conflict do nothing`,
    [version],
  );
  try {
    return fn();
  } finally {
    await pool.query(`delete from public.schema_migrations where version=$1`, [version]);
  }
}

main().catch((err) => {
  console.error("legacy-repair-verify beklenmedik hata ile durdu:", err);
  process.exit(1);
});
