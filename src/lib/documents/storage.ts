// Faz 35 — local-disk document storage.
//
// ═══ OPEN QUESTION #7: LOCAL DISK, MIRRORING FAZ 2 ═══
//
// The precedent already exists in this repo: `source_workbooks` (migration 0001) stores
// `storage_path` + `file_sha256` and keeps the bytes on disk. `attachments` uses the same two
// columns for the same reason, rather than inventing a second storage convention.
//
// Object storage was rejected: it adds an external cloud dependency to a system CLAUDE.md defines
// as single-company, private and internal, and it puts financial documents somewhere the owner
// cannot open with a file manager.
//
// Bytes-in-Postgres was rejected on measured grounds: Faz 33 found that at 24.000 invoices the
// pg_dump was already big enough to break backup verification outright. Every scanned contract
// added to the dump makes the mandatory pre-migration backup harder to take, and that backup is
// the one thing that must stay practical.
//
// ═══ WHAT LOCAL DISK COSTS, SAID OUT LOUD ═══
//
// The database alone is no longer a complete restore: a dump plus a lost documents directory is a
// dump full of dead links. Two things follow, and both are implemented rather than hoped for:
//   * `file_sha256` is NOT NULL in 0083, so a restore can PROVE which files are missing or
//     corrupt instead of silently serving wrong bytes.
//   * `verifyStored()` re-hashes on read, so corruption surfaces as an error and not as a
//     document that quietly changed.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Where documents live.
 *
 * Overridable so a deployment can point at a mounted volume, defaulting to a directory beside the
 * project rather than inside it — documents are data, not source, and must never end up in git.
 */
export function documentRoot(): string {
  return process.env.MAS_DOCUMENT_ROOT ?? path.join(process.cwd(), "data", "documents");
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface StoredFile {
  storagePath: string;
  sha256: string;
  byteSize: number;
}

/**
 * Content-addressed layout: <root>/<aa>/<bb>/<full-sha256>.
 *
 * Addressing by hash rather than by original filename does three things at once: identical bytes
 * are stored once, a malicious or careless filename can never escape the root (there is no user
 * text in the path at all), and the file's own name is its integrity check. The two-level fan-out
 * keeps directory sizes sane on a filesystem that dislikes 100.000 entries in one folder.
 */
export function storagePathFor(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error("storagePathFor: geçersiz sha256");
  }
  return path.join(hash.slice(0, 2), hash.slice(2, 4), hash);
}

/** Write bytes and return what the database row should record. Idempotent by construction. */
export function storeFile(bytes: Buffer): StoredFile {
  const hash = sha256(bytes);
  const relative = storagePathFor(hash);
  const absolute = path.join(documentRoot(), relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  // Identical bytes already on disk: nothing to do. Re-writing would be a no-op at best and a
  // window where the file is truncated at worst.
  if (!existsSync(absolute)) {
    writeFileSync(absolute, bytes);
  }
  return { storagePath: relative, sha256: hash, byteSize: bytes.byteLength };
}

export class DocumentIntegrityError extends Error {}

/**
 * Read a stored file and verify it against the recorded hash.
 *
 * Refuses to return bytes that do not match. A document centre that serves silently-corrupted
 * files is worse than one that is down: the corruption gets filed, mailed and relied upon.
 */
export function readStored(storagePath: string, expectedSha256: string): Buffer {
  const absolute = path.join(documentRoot(), storagePath);
  if (!existsSync(absolute)) {
    throw new DocumentIntegrityError(`Dosya diskte yok: ${storagePath}`);
  }
  const bytes = readFileSync(absolute);
  const actual = sha256(bytes);
  if (actual !== expectedSha256) {
    throw new DocumentIntegrityError(
      `Sağlama uyuşmuyor (${storagePath}): beklenen ${expectedSha256.slice(0, 12)}…, bulunan ${actual.slice(0, 12)}…`);
  }
  return bytes;
}

export interface IntegrityReport {
  storagePath: string;
  present: boolean;
  sizeMatches: boolean | null;
  hashMatches: boolean | null;
}

/**
 * Check one attachment without loading it into a response.
 *
 * Separate from readStored so an integrity sweep over the whole archive does not have to serve
 * anything — the report is the point.
 */
export function verifyStored(
  storagePath: string, expectedSha256: string, expectedSize: number,
): IntegrityReport {
  const absolute = path.join(documentRoot(), storagePath);
  if (!existsSync(absolute)) {
    return { storagePath, present: false, sizeMatches: null, hashMatches: null };
  }
  const size = statSync(absolute).size;
  // Size is checked first because it is nearly free; a mismatch means the hash cannot match
  // either, and there is no reason to read a large file to learn that.
  if (size !== expectedSize) {
    return { storagePath, present: true, sizeMatches: false, hashMatches: null };
  }
  const actual = sha256(readFileSync(absolute));
  return { storagePath, present: true, sizeMatches: true, hashMatches: actual === expectedSha256 };
}
