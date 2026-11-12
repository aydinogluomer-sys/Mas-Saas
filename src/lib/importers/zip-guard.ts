// Faz 41 (B1) — Centralized OOXML (.xlsx) ZIP bomb & legacy binary (.xls) security guard.
//
// Runs on raw Buffer bytes BEFORE ExcelJS inflates any entry into memory on the 8 GB RAM host.
// Enforces:
//   1. Non-empty buffer
//   2. Explicit rejection of legacy binary BIFF/CFB `.xls` (`0xd0cf11e0`)
//   3. Valid PKZIP signature (`0x504b0304`)
//   4. Max entry count (`MAX_ZIP_ENTRIES = 512`)
//   5. Max cumulative uncompressed payload (`MAX_UNCOMPRESSED_BYTES = 100 MB`) across both
//      Central Directory headers and Local File Headers (defeating spoofed header mismatches & ZIP64 bombs).

export const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_ZIP_ENTRIES = 512;

const ZIP_LOCAL_MAGIC = 0x04034b50; // PK\x03\x04
const ZIP_CENTRAL_MAGIC = 0x02014b50; // PK\x01\x02
const ZIP_EOCD_MAGIC = 0x06054b50; // PK\x05\x06
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // legacy .xls (Compound File Binary)
const ZIP_MAGIC_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP64_SENTINEL = 0xffffffff;

export type ZipSafetyCode =
  | "EMPTY_FILE"
  | "LEGACY_XLS"
  | "INVALID_SIGNATURE"
  | "CORRUPT_ZIP"
  | "TOO_MANY_ENTRIES"
  | "UNCOMPRESSED_TOO_LARGE";

export type ZipSafetyResult =
  | {
      ok: true;
      entryCount: number;
      totalUncompressedBytes: number;
    }
  | {
      ok: false;
      code: ZipSafetyCode;
      error: string;
    };

export interface ZipSafetyLimits {
  maxEntries?: number;
  maxUncompressedBytes?: number;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // EOCD record is at least 22 bytes; comment length is uint16 (max 65535).
  const minOffset = Math.max(0, buf.length - 22 - 65535);
  for (let offset = buf.length - 22; offset >= minOffset; offset--) {
    if (buf.readUInt32LE(offset) === ZIP_EOCD_MAGIC) {
      const commentLen = buf.readUInt16LE(offset + 20);
      if (offset + 22 + commentLen === buf.length) {
        return offset;
      }
    }
  }
  // Fallback scan without exact trailing-length match (tolerates minor trailing padding if valid CD follows)
  for (let offset = buf.length - 22; offset >= minOffset; offset--) {
    if (buf.readUInt32LE(offset) === ZIP_EOCD_MAGIC) {
      return offset;
    }
  }
  return -1;
}

export function inspectZipSafety(buf: Buffer, limits?: ZipSafetyLimits): ZipSafetyResult {
  const maxEntries = limits?.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxUncompressedBytes = limits?.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES;

  if (buf.length === 0) {
    return { ok: false, code: "EMPTY_FILE", error: "empty file (0 bytes)" };
  }

  const head = buf.subarray(0, Math.min(4, buf.length));
  if (head.length === 4 && head.equals(CFB_MAGIC)) {
    return {
      ok: false,
      code: "LEGACY_XLS",
      error:
        "Eski .xls biçimi güvenlik nedeniyle desteklenmiyor; lütfen dosyayı Excel'de .xlsx olarak kaydedip yükleyin.",
    };
  }

  if (head.length < 4 || !head.equals(ZIP_MAGIC_BYTES)) {
    const hex = head.toString("hex").padEnd(8, "0");
    return {
      ok: false,
      code: "INVALID_SIGNATURE",
      error: `no valid XLSX/ZIP signature (first bytes: 0x${hex}); file is not a parseable workbook`,
    };
  }

  if (buf.length < 22) {
    return {
      ok: false,
      code: "CORRUPT_ZIP",
      error: "Bozuk ZIP/XLSX arşivi (EOCD başlığı eksik).",
    };
  }

  const eocdOffset = findEndOfCentralDirectory(buf);
  if (eocdOffset < 0) {
    return {
      ok: false,
      code: "CORRUPT_ZIP",
      error: "Bozuk ZIP/XLSX arşivi (merkezi dizin sonu bulunamadı).",
    };
  }

  const totalEntriesDeclared = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (totalEntriesDeclared === 0xffff || cdSize === ZIP64_SENTINEL || cdOffset === ZIP64_SENTINEL) {
    return {
      ok: false,
      code: "UNCOMPRESSED_TOO_LARGE",
      error: "ZIP64 arşivi güvenlik sınırını aşıyor; maksimum 100 MB açılmış boyut desteklenir.",
    };
  }

  if (totalEntriesDeclared > maxEntries) {
    return {
      ok: false,
      code: "TOO_MANY_ENTRIES",
      error: `XLSX arşivi çok fazla iç dosya içeriyor (${totalEntriesDeclared} > ${maxEntries}).`,
    };
  }

  if (cdOffset + cdSize > eocdOffset || cdOffset >= buf.length) {
    return {
      ok: false,
      code: "CORRUPT_ZIP",
      error: "Bozuk ZIP/XLSX merkezi dizin sınırları.",
    };
  }

  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let entryCount = 0;
  let totalUncompressedBytes = 0;

  while (cursor < cdEnd) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== ZIP_CENTRAL_MAGIC) {
      return {
        ok: false,
        code: "CORRUPT_ZIP",
        error: "Bozuk ZIP/XLSX merkezi dizin kaydı.",
      };
    }

    entryCount += 1;
    if (entryCount > maxEntries) {
      return {
        ok: false,
        code: "TOO_MANY_ENTRIES",
        error: `XLSX arşivi çok fazla iç dosya içeriyor (${entryCount} > ${maxEntries}).`,
      };
    }

    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const fileNameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);

    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      return {
        ok: false,
        code: "UNCOMPRESSED_TOO_LARGE",
        error: "ZIP64 giriş boyutu güvenlik sınırını aşıyor.",
      };
    }

    // Cross-check Local File Header so a malicious archive cannot hide a giant local uncompressed size.
    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_MAGIC) {
      return {
        ok: false,
        code: "CORRUPT_ZIP",
        error: "Bozuk ZIP/XLSX yerel dosya başlığı.",
      };
    }
    const localUncompressed = buf.readUInt32LE(localHeaderOffset + 22);
    if (localUncompressed === ZIP64_SENTINEL) {
      return {
        ok: false,
        code: "UNCOMPRESSED_TOO_LARGE",
        error: "ZIP64 yerel giriş boyutu güvenlik sınırını aşıyor.",
      };
    }

    const effectiveUncompressed = Math.max(uncompressedSize, localUncompressed);
    totalUncompressedBytes += effectiveUncompressed;
    if (totalUncompressedBytes > maxUncompressedBytes) {
      return {
        ok: false,
        code: "UNCOMPRESSED_TOO_LARGE",
        error: `XLSX açılmış boyutu güvenlik tavanını aşıyor (${totalUncompressedBytes} > ${maxUncompressedBytes} bayt).`,
      };
    }

    cursor += 46 + fileNameLen + extraLen + commentLen;
  }

  return {
    ok: true,
    entryCount,
    totalUncompressedBytes,
  };
}

