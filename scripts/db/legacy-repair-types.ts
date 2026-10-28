// Shared schemas + pure utilities for the P0-B Slice 5 legacy repair toolchain
// (legacy-repair-inventory.ts / -approval.ts / -apply.ts / -recover-receipt.ts / -verify.ts).
// This module never touches the DB or the filesystem's business data — only Zod schemas,
// a deterministic "project canonical JSON v1" serializer, domain-specific array sorting,
// SHA-256 helpers, and durable-write helpers with explicit Windows durability metadata.

import { z } from "zod";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync } from "node:fs";
import path from "node:path";

export const CANONICALIZATION_VERSION = "project-canonical-json-v1" as const;
// inventoryManifestVersion is the SEMANTIC data-model version of the inventory manifest —
// what the fields mean and which invariants the generator upholds (e.g. paymentId always
// reflecting the live row, not a hardcoded/omitted value). This is independent from
// canonicalizationVersion, which names only the JSON serialization algorithm — a manifest
// can be byte-for-byte "project-canonical-json-v1" while its DATA MODEL is subtly wrong,
// exactly as today's paymentId defect was. A materially different data model MUST bump
// this literal so old-shape files are rejected by schema alone, never by accident of
// which fields happen to still be present.
export const INVENTORY_MANIFEST_VERSION = "legacy-repair-inventory-v3" as const;

/* ── primitive schemas ── */

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// Accepts BOTH JS-origin (.toISOString(), always 3-digit ms) and DB-origin
// (to_char(...,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), always 6-digit us) instant shapes —
// shape alone is not enough (regex accepts 2026-02-31), so the date portion is also
// round-tripped through Date.UTC and compared back, exactly like assertISODateString.
const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/;
export const IsoInstant = z.string().refine(
  (s) => {
    const m = ISO_INSTANT_RE.exec(s);
    if (!m) return false;
    return isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
  },
  { message: "geçersiz ISO instant (şekil veya takvimsel geçerlilik)" },
);

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const IsoDate = z.string().refine(
  (s) => {
    const m = ISO_DATE_RE.exec(s);
    if (!m) return false;
    return isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
  },
  { message: "geçersiz ISO tarih (şekil veya takvimsel geçerlilik)" },
);

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "geçersiz SHA-256 hex");
export const GitHead = z.string().regex(/^[0-9a-f]{40}$/, "geçersiz git HEAD");
export const SystemIdentifier = z.string().regex(/^\d+$/, "geçersiz system_identifier");
export const MigrationVersion = z.string().regex(/^\d{4}$/, "geçersiz migration versiyonu");
export const Uuid = z.uuid();

/* ── git-state provenance, dependency-injectable ── shared by backup-receipt.ts's
   pre/post-dump provenance gate and legacy-repair-apply.ts's pre-transaction gate.
   Production entrypoints (both scripts' `main()`) ALWAYS call these with the REAL
   provider (the default parameter) — there is no CLI flag, environment variable, or
   `--allow-dirty`-style switch that lets a real invocation substitute anything else.
   The injection seam exists ONLY at the programmatic/module level, exercised by
   legacy-repair-verify.ts importing these functions directly and passing a controlled
   fake provider — never reachable through either script's command-line surface. */

export interface GitStateProvider {
  getBranch: () => string;
  getHead: () => string;
  isClean: () => boolean;
}

export interface GitState {
  branch: string;
  head: string;
  clean: boolean;
}

/** Pure predicate over `git status --porcelain` output, kept side-effect-free so it can
 * be unit-tested directly against a FABRICATED string — never by dirtying this
 * repository's own real working tree as a test side effect. */
export function isCleanWorkingTree(porcelainOutput: string): boolean {
  return porcelainOutput.trim().length === 0;
}

/** The one real implementation, used by every production entrypoint by default. Reads
 * whatever git repository contains the calling process's own `process.cwd()` — this is
 * what lets legacy-repair-verify.ts point a real `tsx` subprocess at an isolated,
 * disposable git repository (via the subprocess's `cwd`) instead of this project's own
 * working tree, for the handful of tests that need a real, genuinely clean repository
 * rather than a fake provider. */
export const REAL_GIT_STATE_PROVIDER: GitStateProvider = {
  getBranch: () => execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
  getHead: () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  isClean: () => isCleanWorkingTree(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })),
};

export function readGitState(provider: GitStateProvider = REAL_GIT_STATE_PROVIDER): GitState {
  return { branch: provider.getBranch(), head: provider.getHead(), clean: provider.isClean() };
}

/** Fail-closed: throws unless the live git state exactly matches `expected` AND the
 * working tree is clean. Used by backup-receipt.ts's runBackupReceipt() both before and
 * after the dump (a dirty/mismatched read at EITHER point invalidates the whole backup —
 * see runBackupReceipt's own comment for why post-dump re-verification matters). */
export function assertExpectedCleanGitState(
  expected: { branch: string; head: string },
  provider: GitStateProvider = REAL_GIT_STATE_PROVIDER,
): GitState {
  const state = readGitState(provider);
  if (state.branch !== expected.branch) {
    throw new Error(`Git branch uyuşmuyor: canlı='${state.branch}' beklenen='${expected.branch}'`);
  }
  if (state.head !== expected.head) {
    throw new Error(`Git HEAD uyuşmuyor: canlı='${state.head}' beklenen='${expected.head}'`);
  }
  if (!state.clean) {
    throw new Error(`Git working tree temiz değil — işlem başlatılamaz.`);
  }
  return state;
}

/* ── durability metadata — every manifest/receipt-type write records its own. Defined
   here (before inventory/approval manifests) since both now embed it directly. ── */

export const DurabilityMetadataSchema = z
  .object({
    platform: z.enum(["win32", "linux", "darwin"]),
    durabilityMode: z.enum(["full-directory-fsync", "windows-best-effort"]),
    directoryFsyncAttempted: z.boolean(),
    directoryFsyncSupported: z.boolean(),
    directoryFsyncErrorCode: z.string().nullable(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.durabilityMode === "windows-best-effort" && d.platform !== "win32") {
      ctx.addIssue({ code: "custom", message: "durabilityMode='windows-best-effort' yalnız platform='win32' için geçerli olabilir" });
    }
    if (d.durabilityMode === "windows-best-effort" && d.directoryFsyncSupported) {
      ctx.addIssue({ code: "custom", message: "durabilityMode='windows-best-effort' iken directoryFsyncSupported=true olamaz" });
    }
    if (d.durabilityMode === "full-directory-fsync" && !d.directoryFsyncSupported) {
      ctx.addIssue({ code: "custom", message: "durabilityMode='full-directory-fsync' iken directoryFsyncSupported=false olamaz" });
    }
    if (d.directoryFsyncSupported && d.directoryFsyncErrorCode !== null) {
      ctx.addIssue({ code: "custom", message: "directoryFsyncSupported=true iken directoryFsyncErrorCode null olmalı" });
    }
    if (!d.directoryFsyncSupported && d.directoryFsyncErrorCode === null) {
      ctx.addIssue({ code: "custom", message: "directoryFsyncSupported=false iken directoryFsyncErrorCode null olamaz" });
    }
  });
export type DurabilityMetadata = z.infer<typeof DurabilityMetadataSchema>;

/* ── inventory manifest ── */

export const TargetKind = z.enum(["cancellation_metadata_repair", "archive_cascade_repair"]);
export const TargetClassification = z.enum(["candidate", "unresolved", "ineligible"]);
export const CancelledAtPolicy = z.enum(["fixed_evidence_timestamp", "apply_transaction_timestamp"]);

export const InventoryTargetSchema = z
  .object({
    kind: TargetKind,
    paymentId: Uuid.nullable(),
    instanceId: Uuid,
    beforeStateHash: Sha256Hex,
    classification: TargetClassification,
    proposedCancelledAt: IsoInstant.nullable(),
    cancelledAtPolicy: CancelledAtPolicy.nullable(),
    proposedCancelReason: z.string().nullable(),
    rationale: z.string().min(1),
  })
  .strict();
export type InventoryTarget = z.infer<typeof InventoryTargetSchema>;

const InventoryEvidenceAuditRowSchema = z
  .object({
    id: Uuid,
    action: z.string().min(1),
    createdAt: IsoInstant,
    canonicalHash: Sha256Hex,
  })
  .strict();

export const InventoryManifestSchema = z
  .object({
    canonicalizationVersion: z.literal(CANONICALIZATION_VERSION),
    inventoryManifestVersion: z.literal(INVENTORY_MANIFEST_VERSION),
    generatedAt: IsoInstant,
    todayISO: IsoDate,
    timezone: z.literal("Europe/Istanbul"),
    gitHead: GitHead,
    databaseName: z.string().min(1),
    systemIdentifier: SystemIdentifier,
    ledgerCount: z.number().int().nonnegative(),
    lastMigrationVersion: MigrationVersion,
    evidence: z
      .object({
        legacyInstanceAuditRow: InventoryEvidenceAuditRowSchema.nullable(),
        archivedPaymentAuditRow: InventoryEvidenceAuditRowSchema
          .extend({ archiveReason: z.string(), archivedAt: IsoInstant })
          .nullable(),
      })
      .strict(),
    archivedPayment: z.object({ id: Uuid, beforeStateHash: Sha256Hex }).strict().nullable(),
    targets: z.array(InventoryTargetSchema).superRefine((targets, ctx) => {
      const seen = new Set<string>();
      for (const t of targets) {
        const key = `${t.instanceId}|${t.kind}`;
        if (seen.has(key)) {
          ctx.addIssue({ code: "custom", message: `duplicate inventory target: ${key}` });
        }
        seen.add(key);
      }
    }),
    inventoryPayloadSha256: Sha256Hex,
    // Transport/file-write metadata — deliberately NOT part of the semantic payload hash
    // scope (see inventoryPayloadSha256's computation in legacy-repair-inventory.ts): it
    // describes how this specific file was written, not what it says, and is only known
    // after the write's own directory-fsync probe runs.
    durability: DurabilityMetadataSchema,
  })
  .strict();
export type InventoryManifest = z.infer<typeof InventoryManifestSchema>;

/* ── approval manifest ── */

export const ApprovalEntrySchema = z
  .object({
    instanceId: Uuid,
    kind: TargetKind,
    approvedCancelledAt: IsoInstant.nullable(),
    approvedCancelReason: z.string().min(1),
    reasonSource: z.literal("user_supplied"),
  })
  .strict();
export type ApprovalEntry = z.infer<typeof ApprovalEntrySchema>;

export const ApprovalManifestSchema = z
  .object({
    canonicalizationVersion: z.literal(CANONICALIZATION_VERSION),
    // Carries the semantic version of the inventory this approval was generated from, so
    // the receipt chain records which inventory data-model contract the approval is bound
    // to — independent of canonicalizationVersion (serialization format only).
    sourceInventoryManifestVersion: z.literal(INVENTORY_MANIFEST_VERSION),
    approvedAt: IsoInstant,
    inventoryFileSha256: Sha256Hex,
    approvals: z
      .array(ApprovalEntrySchema)
      .min(1, "sıfır onaylı hedefle approval manifest üretilemez")
      .superRefine((approvals, ctx) => {
        const seen = new Set<string>();
        for (const a of approvals) {
          if (seen.has(a.instanceId)) {
            ctx.addIssue({ code: "custom", message: `duplicate approval: ${a.instanceId}` });
          }
          seen.add(a.instanceId);
        }
      }),
    archiveCascadePolicy: z
      .object({ cancelledAtPolicy: z.literal("apply_transaction_timestamp") })
      .strict()
      .nullable(),
    approvalPayloadSha256: Sha256Hex,
    // Transport/file-write metadata — same exclusion-from-payload-hash policy as
    // InventoryManifestSchema's durability field; see that field's comment.
    durability: DurabilityMetadataSchema,
  })
  .strict();
export type ApprovalManifest = z.infer<typeof ApprovalManifestSchema>;

/* ── receipt core + discriminated receipt file union ── */

export const AdvisoryLockKeySchema = z
  .object({ name: z.string().min(1), hash64: z.string().regex(/^-?\d+$/, "geçersiz 64-bit hash") })
  .strict();

// Mirrors src/lib/radar/engine.ts's AppliedRepairResult exactly (kept in sync manually —
// engine.ts must not import from scripts/, and this module must not import from src/lib/
// application code; legacy-repair-apply.ts is the one place both are used together, and
// TypeScript's structural typing catches any drift at that assignment site).
export const AppliedRepairResultSchema = z
  .object({
    instanceId: Uuid,
    kind: TargetKind,
    auditId: Uuid,
    cancelledAt: IsoInstant,
    beforeHash: Sha256Hex,
    afterHash: Sha256Hex,
  })
  .strict();
export type AppliedRepairResult = z.infer<typeof AppliedRepairResultSchema>;

export const ReceiptCoreSchema = z
  .object({
    canonicalizationVersion: z.literal(CANONICALIZATION_VERSION),
    operationId: Uuid,
    inventoryFileSha256: Sha256Hex,
    approvalFileSha256: Sha256Hex,
    backupSha256: Sha256Hex,
    backupReceiptSha256: Sha256Hex,
    gitHead: GitHead,
    databaseName: z.string().min(1),
    systemIdentifier: SystemIdentifier,
    ledgerCount: z.number().int().nonnegative(),
    lastMigrationVersion: MigrationVersion,
    transactionTimestamp: IsoInstant,
    advisoryLockKey: AdvisoryLockKeySchema,
    // A single linked array — never separate, independently-sortable ID lists. Every
    // applied repair carries its own instanceId+auditId+kind together, so "does this
    // audit row belong to this instance" is a property of one array entry, not a
    // cross-array lookup. Duplicate instanceId/auditId are rejected, and the array MUST
    // already be in canonical (ascending instanceId) order — a non-canonical file is
    // rejected outright, never silently re-sorted and accepted.
    appliedRepairs: z
      .array(AppliedRepairResultSchema)
      .min(1)
      .superRefine((repairs, ctx) => {
        const instanceIds = new Set<string>();
        const auditIds = new Set<string>();
        for (const r of repairs) {
          if (instanceIds.has(r.instanceId)) {
            ctx.addIssue({ code: "custom", message: `duplicate instanceId in appliedRepairs: ${r.instanceId}` });
          }
          instanceIds.add(r.instanceId);
          if (auditIds.has(r.auditId)) {
            ctx.addIssue({ code: "custom", message: `duplicate auditId in appliedRepairs: ${r.auditId}` });
          }
          auditIds.add(r.auditId);
        }
        for (let i = 1; i < repairs.length; i++) {
          if (repairs[i - 1].instanceId >= repairs[i].instanceId) {
            ctx.addIssue({ code: "custom", message: `appliedRepairs canonical sırada değil (instanceId'ye göre kesin artan olmalı), index ${i}` });
            break;
          }
        }
      }),
    untouchedInstanceIds: z.array(Uuid).superRefine((ids, ctx) => {
      for (let i = 1; i < ids.length; i++) {
        if (ids[i - 1] >= ids[i]) {
          ctx.addIssue({ code: "custom", message: `untouchedInstanceIds canonical sırada değil, index ${i}` });
          break;
        }
      }
    }),
    untouchedScopeBeforeHash: Sha256Hex,
    untouchedScopeAfterHash: Sha256Hex,
  })
  .strict();
export type ReceiptCore = z.infer<typeof ReceiptCoreSchema>;

export const PendingReceiptFileSchema = z
  .object({
    status: z.literal("pending"),
    operationId: Uuid,
    receiptCore: ReceiptCoreSchema,
    receiptCoreSha256: Sha256Hex,
    durability: DurabilityMetadataSchema,
  })
  .strict();
export type PendingReceiptFile = z.infer<typeof PendingReceiptFileSchema>;

export const CommittedReceiptFileSchema = z
  .object({
    status: z.literal("committed"),
    operationId: Uuid,
    receiptCore: ReceiptCoreSchema,
    receiptCoreSha256: Sha256Hex,
    pendingFileSha256: Sha256Hex,
    summaryAuditId: Uuid,
    summaryAuditCreatedAt: IsoInstant,
    finalizationMode: z.enum(["normal", "recovered"]),
    durability: DurabilityMetadataSchema,
  })
  .strict();
export type CommittedReceiptFile = z.infer<typeof CommittedReceiptFileSchema>;

export const RolledBackReceiptFileSchema = z
  .object({
    status: z.literal("rolled_back"),
    operationId: Uuid,
    pendingFileSha256: Sha256Hex.nullable(),
    failureStage: z.enum([
      "precondition",
      "eligibility",
      "repair_update",
      "pending_write",
      "summary_audit_insert",
    ]),
    failureReason: z.string().min(1),
    durability: DurabilityMetadataSchema,
  })
  .strict();
export type RolledBackReceiptFile = z.infer<typeof RolledBackReceiptFileSchema>;

export const ReceiptFileSchema = z.discriminatedUnion("status", [
  PendingReceiptFileSchema,
  CommittedReceiptFileSchema,
  RolledBackReceiptFileSchema,
]);
export type ReceiptFile = z.infer<typeof ReceiptFileSchema>;

/* ── backup receipt ── */

// Structured proof that the dump's own file-level integrity flow (backup-docker-
// postgres.ts's temp-write → fsync → restore-listable → atomic-rename → final-reverify)
// genuinely ran and passed — not merely printed to a console log. Every field is a
// `z.literal(true)` (or a positive count / a strict nested object of literals): a receipt
// produced by code that skipped or failed any one of these steps is missing the field
// entirely and is rejected by strict-schema parsing alone, exactly like
// targetVerificationCompleted above.
export const DumpVerificationSchema = z
  .object({
    fileFsyncCompleted: z.literal(true),
    tempRestoreListable: z.literal(true),
    atomicRenameCompleted: z.literal(true),
    finalByteSizeVerified: z.literal(true),
    finalSha256Verified: z.literal(true),
    finalRestoreListable: z.literal(true),
    tocEntryCount: z.number().int().positive(),
    criticalTablesPresent: z
      .object({
        paymentInstances: z.literal(true),
        payments: z.literal(true),
        auditLogs: z.literal(true),
        schemaMigrations: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type DumpVerification = z.infer<typeof DumpVerificationSchema>;

export const BackupReceiptSchema = z
  .object({
    canonicalizationVersion: z.literal(CANONICALIZATION_VERSION),
    // Real `git branch --show-current`/`rev-parse HEAD` at backup time — lets apply.ts
    // refuse a backup taken on a different branch or against a different code version
    // than the one currently checked out.
    gitBranch: z.string().min(1),
    gitHead: GitHead,
    // The Docker container the dump was actually taken from — recorded so the cluster-
    // binding provenance below (sourceDatabaseName/sourceSystemIdentifier) is traceable
    // back to a concrete backup source, not just an abstract claim.
    containerName: z.string().min(1),
    path: z.string().min(1),
    bytes: z.number().int().positive(),
    sha256: Sha256Hex,
    databaseName: z.string().min(1),
    systemIdentifier: SystemIdentifier,
    // Independently re-derived by querying the CONTAINER (via `docker exec ... psql`),
    // not the TCP connection above — proves the dump's actual source is the same
    // Postgres cluster as `databaseName`/`systemIdentifier`, not a same-named database on
    // a different cluster. See verifyBackupTarget() in backup-docker-postgres.ts.
    sourceDatabaseName: z.string().min(1),
    sourceSystemIdentifier: SystemIdentifier,
    // Only ever `true` — its role is structural, not informational: a receipt produced by
    // code that never ran the container-vs-TCP cross-check (e.g. an old-format receipt)
    // is missing this field entirely and is rejected by strict-schema parsing alone.
    targetVerificationCompleted: z.literal(true),
    ledgerCount: z.number().int().nonnegative(),
    lastMigrationVersion: MigrationVersion,
    backupStartedDbTimestamp: IsoInstant,
    backupCompletedDbTimestamp: IsoInstant,
    // Structured proof of the dump's own file-integrity flow — see DumpVerificationSchema
    // above. Immutable and hash-scoped: this is not merely printed to the console.
    dumpVerification: DumpVerificationSchema,
    // Durability of the DUMP file itself (backupDockerPostgres's own temp-write + atomic
    // rename + directory-fsync) and durability of the RECEIPT file's own write are
    // deliberately separate fields — they are two different files, written at two
    // different times by two different functions, and conflating them into one field
    // would leave it ambiguous which file's write behavior is actually being described.
    dumpDurability: DurabilityMetadataSchema,
    receiptDurability: DurabilityMetadataSchema,
    // AŞAMA 07 (rehber §12 Bölüm A): sunucu ve pg_dump sürümleri. Kurtarma anında makbuz
    // operatörün elindeki TEK bilgidir; 16.14 ile yazılmış bir arşivin daha eski bir
    // pg_restore ile yüklenebileceği garanti değildir. `optional()` bilinçli: bu alanlar
    // eklenmeden ÖNCE üretilmiş makbuzlar (legacy-repair akışının okuduğu makbuzlar dahil)
    // geçerliliğini korumalı — geriye dönük kırılma, yeni bir alan uğruna ödenecek bir
    // bedel değildir. Yeni üretilen her makbuz ikisini de doldurur.
    pgVersion: z.string().min(1).optional(),
    pgDumpVersion: z.string().min(1).optional(),
  })
  .strict();
export type BackupReceipt = z.infer<typeof BackupReceiptSchema>;

/* ── canonical serialization ("project canonical JSON v1", NOT a JCS/RFC 8785 claim) ──
   Generic on purpose: preserves whatever array order it is given. Callers (inventory/
   approval/apply/verify builders) are responsible for sorting any set-like array
   deterministically BEFORE calling this — see sort* helpers below. */

export function canonicalSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`canonicalSerialize: yalnız safe integer kabul edilir, alınan ${value}`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalSerialize(v)).join(",")}]`;
  }
  if (value === undefined) throw new Error("canonicalSerialize: undefined kabul edilmez");
  if (value instanceof Date) throw new Error("canonicalSerialize: Date nesnesi kabul edilmez — önce string'e çevrilmeli");
  if (typeof value === "bigint") throw new Error("canonicalSerialize: bigint kabul edilmez");
  if (typeof value === "function") throw new Error("canonicalSerialize: function kabul edilmez");
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("canonicalSerialize: yalnız plain object kabul edilir");
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalSerialize(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalSerialize: desteklenmeyen tür: ${typeof value}`);
}

/* ── domain-specific deterministic sorting — NOT done by canonicalSerialize itself ── */

export function sortTargetsDeterministically<T extends { instanceId: string; kind: string }>(targets: T[]): T[] {
  return [...targets].sort((a, b) => {
    if (a.instanceId !== b.instanceId) return a.instanceId < b.instanceId ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
}
export function sortApprovalsDeterministically<T extends { instanceId: string }>(approvals: T[]): T[] {
  return sortById(approvals);
}
export function sortAppliedRepairsDeterministically<T extends { instanceId: string }>(repairs: T[]): T[] {
  return sortById(repairs);
}
function sortById<T extends { instanceId: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0));
}
export function sortIdsDeterministically(ids: string[]): string[] {
  return [...ids].sort();
}

/* ── hashing ── */

export function fileSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Hashes the canonical serialization of `value` — callers must pass an object with all
 * set-like arrays already domain-sorted (see above) and any excluded fields (generatedAt,
 * approvedAt, the hash field itself) already stripped out. */
export function payloadSha256(value: unknown): string {
  return createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex");
}
/** Hashes a raw SQL-produced string directly (e.g. to_jsonb(t)::text for a before-state
 * row hash) — no JS-side reconstruction of the value, avoiding the Date/timezone pitfall
 * discovered while building reconciliation-verify.ts in Slice 4. */
export function canonicalHash(rawText: string): string {
  return createHash("sha256").update(rawText, "utf8").digest("hex");
}

/* ── durable file writes with explicit, verified Windows durability ── */

export type Platform = "win32" | "linux" | "darwin";

export interface DirectoryFsyncImpl {
  open: (path: string, flags: string) => number;
  fsync: (fd: number) => void;
  close: (fd: number) => void;
}
const REAL_DIRECTORY_FSYNC_IMPL: DirectoryFsyncImpl = { open: openSync, fsync: fsyncSync, close: closeSync };

// Only codes empirically confirmed (EPERM, on this project's real Windows/Node host — see
// attemptDirectoryFsync's own doc comment) or well-documented across Node/libuv versions
// for this exact "fsync a directory handle on Windows" limitation (ENOSYS) are tolerated.
// EINVAL is deliberately NOT included: it has not been empirically observed on this host,
// and this project does not hardcode a tolerated error code without either empirical
// confirmation or a git-blameable documented reason. Add it here (with that justification
// recorded) only if a real host is ever actually seen throwing it.
const WINDOWS_TOLERATED_DIRECTORY_FSYNC_CODES = new Set(["EPERM", "ENOSYS"]);

/** Determines (and, on success, exercises) this host's directory-fsync durability. On
 * win32, 'r+' is tried first — empirically confirmed on this project's real Windows/
 * Node (v26.3.0) host to achieve genuine fsync SUCCESS on a directory handle, unlike the
 * traditional POSIX 'r' pattern, which reliably throws EPERM here — falling back to 'r'
 * only if 'r+' itself fails. Best-effort tolerance for known-unsupported codes applies
 * ONLY on win32: on linux/darwin, directory fsync is expected to work, so ANY failure
 * there — including these same codes — is a genuine, fail-closed problem, never a
 * tolerated platform limitation. `platform`/`impl` are injectable ONLY for
 * legacy-repair-verify.ts's disposable-suite simulation of codes this specific host
 * cannot genuinely reproduce (ENOSYS, and unexpected codes like EIO) — every production
 * call site uses the real defaults. */
export function attemptDirectoryFsync(
  dirPath: string,
  platform: NodeJS.Platform = process.platform,
  impl: DirectoryFsyncImpl = REAL_DIRECTORY_FSYNC_IMPL,
): DurabilityMetadata {
  const flagsToTry = platform === "win32" ? (["r+", "r"] as const) : (["r"] as const);
  let lastErrorCode: string | null = null;
  for (const flag of flagsToTry) {
    try {
      const fd = impl.open(dirPath, flag);
      try {
        impl.fsync(fd);
      } finally {
        impl.close(fd);
      }
      return {
        platform: platform as Platform,
        durabilityMode: "full-directory-fsync",
        directoryFsyncAttempted: true,
        directoryFsyncSupported: true,
        directoryFsyncErrorCode: null,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
      lastErrorCode = code;
      if (platform === "win32" && WINDOWS_TOLERATED_DIRECTORY_FSYNC_CODES.has(code)) {
        continue;
      }
      throw err;
    }
  }
  return {
    platform: platform as Platform,
    durabilityMode: "windows-best-effort",
    directoryFsyncAttempted: true,
    directoryFsyncSupported: false,
    directoryFsyncErrorCode: lastErrorCode,
  };
}

/** Compares the filesystem root ("volume") of two paths — e.g. `C:\` vs `D:\` on
 * Windows. Every real call site derives its temp path from the final path itself
 * (`${finalPath}.tmp-...`), so they are always co-located in practice; this guard exists
 * so a cross-volume rename (not atomic, and on some platforms silently falls back to a
 * non-atomic copy+delete) is rejected outright rather than assumed safe. */
export function sameVolume(pathA: string, pathB: string): boolean {
  const rootA = path.parse(path.resolve(pathA)).root.toLowerCase();
  const rootB = path.parse(path.resolve(pathB)).root.toLowerCase();
  return rootA === rootB;
}

function assertDurabilityUnchanged(probed: DurabilityMetadata, confirmed: DurabilityMetadata, finalPath: string): void {
  if (probed.directoryFsyncSupported !== confirmed.directoryFsyncSupported || probed.directoryFsyncErrorCode !== confirmed.directoryFsyncErrorCode) {
    throw new Error(
      `${finalPath}: directory-fsync davranışı yazma sırasında değişti (probe=${JSON.stringify(probed)}, confirm=${JSON.stringify(confirmed)}) — güvenilmez durum, işlem reddedildi.`,
    );
  }
}

/** Re-opens `finalPath` after the write (or rename) completed and verifies the bytes
 * actually on disk match what was written byte-for-byte (length + SHA-256), then runs
 * the caller's own schema validator against that re-read content — never trusts the
 * in-memory `content` string alone as proof of what was actually persisted. */
function reverifyWrittenFile(finalPath: string, content: string, validate: (rereadContent: string) => void): void {
  const reReadBytes = readFileSync(finalPath);
  const expectedBytes = Buffer.byteLength(content, "utf8");
  if (reReadBytes.length !== expectedBytes) {
    throw new Error(`${finalPath}: yeniden okunan byte sayısı (${reReadBytes.length}) yazılanla (${expectedBytes}) eşleşmiyor.`);
  }
  const reReadSha256 = fileSha256(reReadBytes);
  const expectedSha256 = fileSha256(Buffer.from(content, "utf8"));
  if (reReadSha256 !== expectedSha256) {
    throw new Error(`${finalPath}: yeniden okunan SHA-256 (${reReadSha256}) yazılanla (${expectedSha256}) eşleşmiyor.`);
  }
  validate(reReadBytes.toString("utf8"));
}

/** Writes content built by `buildContent` (given this write's own probed durability
 * metadata, so it can be embedded in the content itself — resolving the chicken-and-egg
 * problem of "durability info must be inside the file, but is only truly known after
 * attempting the directory fsync") directly to `finalPath` via exclusive create (fails
 * if the file already exists — never overwrites), fsyncs the file, then confirms
 * directory-fsync durability again (must match the pre-write probe — any mismatch is
 * treated as an anomaly, not silently accepted), then re-opens the file to verify byte
 * count + SHA-256 + `validate()` against what was actually persisted. Used for files
 * written once at their own final name and never rewritten (the pending receipt). */
export function writeExclusiveDurable(
  finalPath: string,
  buildContent: (durability: DurabilityMetadata) => string,
  validate: (rereadContent: string) => void,
): DurabilityMetadata {
  const dirPath = path.dirname(finalPath);
  const probed = attemptDirectoryFsync(dirPath);
  const content = buildContent(probed);
  const fd = openSync(finalPath, "wx");
  try {
    writeSync(fd, content, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const confirmed = attemptDirectoryFsync(dirPath);
  assertDurabilityUnchanged(probed, confirmed, finalPath);
  reverifyWrittenFile(finalPath, content, validate);
  return confirmed;
}

/** Writes content built by `buildContent` to a unique temp file (exclusive create,
 * required to be on the same volume as `finalPath` — checked BEFORE anything is
 * written), fsyncs it, atomically renames it to `finalPath`, confirms directory-fsync
 * durability again post-rename, then re-opens the final file to verify byte count +
 * SHA-256 + `validate()`. Used for files constructed as a fresh artifact distinct from
 * an earlier immutable one (committed/rolled-back receipts, backup receipts). */
export function writeViaTempAndRename(
  finalPath: string,
  buildContent: (durability: DurabilityMetadata) => string,
  validate: (rereadContent: string) => void,
): DurabilityMetadata {
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  if (!sameVolume(tempPath, finalPath)) {
    throw new Error(
      `writeViaTempAndRename: temp yolu (${tempPath}) ve final yolu (${finalPath}) aynı volume üzerinde değil — rename atomik olmayabilir, işlem başlamadan reddedildi.`,
    );
  }
  const dirPath = path.dirname(finalPath);
  const probed = attemptDirectoryFsync(dirPath);
  const content = buildContent(probed);
  const fd = openSync(tempPath, "wx");
  try {
    writeSync(fd, content, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, finalPath);
  const confirmed = attemptDirectoryFsync(dirPath);
  assertDurabilityUnchanged(probed, confirmed, finalPath);
  reverifyWrittenFile(finalPath, content, validate);
  return confirmed;
}
