// Faz 60 (M-66) — Yedek Arşivi AES-256-GCM Kimlik Doğrulamalı Şifreleme & Çözme Motoru.
//
// Biçim (Magic Header + 12-byte IV + 16-byte GCM AuthTag + Ciphertext):
//   [0..7]   "MASBK01\0" (8 bayt sihirli başlık)
//   [8..19]  12 bayt rastgele IV (nonce)
//   [20..35] 16 bayt AES-256-GCM kimlik doğrulama etiketi (authTag)
//   [36..]   Şifrelenmiş veri (ciphertext)

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const MAGIC = Buffer.from("MASBK01\0", "ascii"); // 8 bytes
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Derives a 32-byte AES-256 key from either a 64-char hex key, 44-char base64 key,
 * or arbitrary high-entropy passphrase (>= 16 chars) via SHA-256.
 */
export function deriveAes256Key(rawKey: string): Buffer {
  const trimmed = rawKey.trim();
  if (trimmed.length < 16) {
    throw new Error("BACKUP_ENCRYPTION_KEY en az 16 karakter (veya 64 haneli hex) olmalıdır.");
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  return createHash("sha256").update(trimmed, "utf8").digest();
}

export function encryptBackupBufferAes256Gcm(plain: Buffer, rawKey: string): Buffer {
  const key = deriveAes256Key(rawKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, authTag, encrypted]);
}

export function decryptBackupBufferAes256Gcm(packed: Buffer, rawKey: string): Buffer {
  const minLen = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (packed.length < minLen || !packed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Geçersiz şifreli yedek başlığı (MASBK01 bekleniyordu).");
  }
  const key = deriveAes256Key(rawKey);
  const iv = packed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const authTag = packed.subarray(MAGIC.length + IV_BYTES, minLen);
  const ciphertext = packed.subarray(minLen);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptBackupFileAes256Gcm(
  srcPath: string,
  destEncPath: string,
  rawKey: string,
): { encryptedPath: string; encryptedBytes: number; encryptedSha256: string } {
  const plain = readFileSync(srcPath);
  const encrypted = encryptBackupBufferAes256Gcm(plain, rawKey);
  writeFileSync(destEncPath, encrypted);
  const encryptedSha256 = createHash("sha256").update(encrypted).digest("hex");
  return {
    encryptedPath: destEncPath,
    encryptedBytes: encrypted.byteLength,
    encryptedSha256,
  };
}

