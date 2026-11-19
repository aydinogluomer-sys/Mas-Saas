// Faz 35 + Faz 50 (D4) — local-disk content-addressed document vault.
//
// Files live on local disk (`MAS_DOCUMENT_STORAGE_DIR` / `MAS_DOCUMENT_ROOT`), never as Postgres
// bytea, and never addressed by the user-supplied filename. Every read re-verifies SHA-256 and
// enforces strict root-containment against path traversal.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DomainError } from "@/lib/domain-error";

export const ALLOWED_DOCUMENT_MIMES = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/xml": "xml",
  "text/xml": "xml",
  "text/csv": "csv",
} as const;

export type AllowedDocumentMime = keyof typeof ALLOWED_DOCUMENT_MIMES;
export type SafeDocumentExt = (typeof ALLOWED_DOCUMENT_MIMES)[AllowedDocumentMime];

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024; // 25 MB

export function documentRoot(): string {
  return (
    process.env.MAS_DOCUMENT_STORAGE_DIR ??
    process.env.MAS_DOCUMENT_ROOT ??
    path.join(process.cwd(), "data", "documents")
  );
}

export function resolveActiveDocumentStorageBackend(): "local_cas" | "s3_worm" {
  return process.env.MAS_S3_WORM_BUCKET ? "s3_worm" : "local_cas";
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ValidatedUploadMeta {
  mimeType: AllowedDocumentMime;
  safeExt: SafeDocumentExt;
  sanitizedOriginalFilename: string;
}

function matchesMagicSignature(bytes: Buffer, safeExt: SafeDocumentExt): boolean {
  if (safeExt === "pdf") {
    return bytes.byteLength >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  }
  if (safeExt === "png") {
    return (
      bytes.byteLength >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (safeExt === "jpg") {
    return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (safeExt === "xml") {
    const head = bytes.subarray(0, 512).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    return head.startsWith("<?xml") || /^<(?:[A-Za-z0-9_]+:)?(?:Invoice|Document|CreditNote|DespatchAdvice|Mizan|TrialBalance)/i.test(head);
  }
  if (safeExt === "csv") {
    return bytes.byteLength > 0 && !bytes.subarray(0, 512).includes(0x00);
  }
  // .xlsx is a ZIP container starting with PK\x03\x04
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/**
 * Validates file size, MIME whitelist, magic-byte signature, and strips any directory components
 * from `originalFilename` before storing it as metadata only.
 */
export function validateDocumentUpload(
  bytes: Buffer,
  rawMimeType: string,
  originalFilename: string,
): ValidatedUploadMeta {
  if (bytes.byteLength === 0) {
    throw new DomainError("VALIDATION", "Boş dosya yüklenemez.");
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DomainError("VALIDATION", "Doküman boyutu 25 MB sınırını aşamaz.");
  }

  let normalizedMime = rawMimeType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  const lowerName = originalFilename.toLowerCase();
  if (
    (!normalizedMime || normalizedMime === "application/octet-stream") &&
    lowerName.endsWith(".xlsx")
  ) {
    normalizedMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  } else if (
    (!normalizedMime || normalizedMime === "application/octet-stream" || normalizedMime === "text/plain") &&
    lowerName.endsWith(".xml")
  ) {
    normalizedMime = "application/xml";
  } else if (
    (!normalizedMime || normalizedMime === "application/octet-stream" || normalizedMime === "text/plain") &&
    lowerName.endsWith(".csv")
  ) {
    normalizedMime = "text/csv";
  } else if (normalizedMime === "image/jpg") {
    normalizedMime = "image/jpeg";
  }

  if (!(normalizedMime in ALLOWED_DOCUMENT_MIMES)) {
    throw new DomainError(
      "VALIDATION",
      "Desteklenmeyen dosya türü. Yalnız PDF, PNG, JPEG, XLSX, XML ve CSV kabul edilir.",
    );
  }

  const mimeType = normalizedMime as AllowedDocumentMime;
  const safeExt = ALLOWED_DOCUMENT_MIMES[mimeType];
  if (!matchesMagicSignature(bytes, safeExt)) {
    throw new DomainError(
      "VALIDATION",
      `Dosya içeriği bildirilen türle (${safeExt.toUpperCase()}) uyuşmuyor.`,
    );
  }

  const base = path.basename(originalFilename.replace(/\\/g, "/")).replace(/[\r\n\0]/g, "").trim();
  const sanitizedOriginalFilename = (base || `document.${safeExt}`).slice(0, 240);
  return { mimeType, safeExt, sanitizedOriginalFilename };
}

export interface StoredFile {
  storagePath: string;
  sha256: string;
  byteSize: number;
}

/**
 * Content-addressed layout: `<aa>/<bb>/<full-sha256>` (or `<aa>/<bb>/<full-sha256>.<safeExt>`).
 * Zero user-controlled characters ever enter the filesystem path.
 */
export function storagePathFor(hash: string, safeExt?: SafeDocumentExt): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error("storagePathFor: geçersiz sha256");
  }
  if (safeExt !== undefined && !["pdf", "png", "jpg", "xlsx", "xml", "csv"].includes(safeExt)) {
    throw new Error("storagePathFor: geçersiz uzantı");
  }
  const leaf = safeExt ? `${hash}.${safeExt}` : hash;
  return path.join(hash.slice(0, 2), hash.slice(2, 4), leaf);
}

function resolveContainedPath(storagePath: string): string {
  if (!storagePath || storagePath.includes("\0")) {
    throw new DocumentIntegrityError("Geçersiz depolama yolu.");
  }
  const rootResolved = path.resolve(documentRoot());
  const candidate = path.resolve(rootResolved, storagePath);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
  if (!candidate.startsWith(prefix)) {
    throw new DocumentIntegrityError(`Dizin dışına çıkış engellendi: ${storagePath}`);
  }
  return candidate;
}

/** Write bytes and return what the database row should record. Idempotent by construction. */
export function storeFile(bytes: Buffer, safeExt?: SafeDocumentExt): StoredFile {
  const hash = sha256(bytes);
  const relative = storagePathFor(hash, safeExt);
  const absolute = resolveContainedPath(relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  if (!existsSync(absolute)) {
    writeFileSync(absolute, bytes);
  }
  return { storagePath: relative, sha256: hash, byteSize: bytes.byteLength };
}

export class DocumentIntegrityError extends Error {}

export function readStored(storagePath: string, expectedSha256: string): Buffer {
  const absolute = resolveContainedPath(storagePath);
  if (!existsSync(absolute)) {
    throw new DocumentIntegrityError(`Dosya diskte yok: ${storagePath}`);
  }
  const bytes = readFileSync(absolute);
  const actual = sha256(bytes);
  if (actual !== expectedSha256) {
    throw new DocumentIntegrityError(
      `Sağlama uyuşmuyor (${storagePath}): beklenen ${expectedSha256.slice(0, 12)}…, bulunan ${actual.slice(0, 12)}…`,
    );
  }
  return bytes;
}

export interface IntegrityReport {
  storagePath: string;
  present: boolean;
  sizeMatches: boolean | null;
  hashMatches: boolean | null;
}

export function verifyStored(
  storagePath: string,
  expectedSha256: string,
  expectedSize: number,
): IntegrityReport {
  const absolute = resolveContainedPath(storagePath);
  if (!existsSync(absolute)) {
    return { storagePath, present: false, sizeMatches: null, hashMatches: null };
  }
  const size = statSync(absolute).size;
  if (size !== expectedSize) {
    return { storagePath, present: true, sizeMatches: false, hashMatches: null };
  }
  const actual = sha256(readFileSync(absolute));
  return { storagePath, present: true, sizeMatches: true, hashMatches: actual === expectedSha256 };
}
