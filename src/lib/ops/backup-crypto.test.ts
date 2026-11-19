import { describe, expect, it } from "vitest";
import {
  decryptBackupBufferAes256Gcm,
  encryptBackupBufferAes256Gcm,
} from "./backup-crypto";

describe("AES-256-GCM Backup Archive Crypto (M-66)", () => {
  const key = "mas-radar-test-backup-encryption-key-2026";

  it("round-trips binary backup payloads identically", () => {
    const sample = Buffer.from("PGDMP\x01\x10\x00MAS_RADAR_STAGE07_DUMP_SAMPLE", "utf8");
    const encrypted = encryptBackupBufferAes256Gcm(sample, key);
    expect(encrypted.subarray(0, 7).toString("ascii")).toBe("MASBK01");
    const decrypted = decryptBackupBufferAes256Gcm(encrypted, key);
    expect(decrypted.equals(sample)).toBe(true);
  });

  it("rejects tampered ciphertext via GCM authentication tag", () => {
    const sample = Buffer.from("immutable-financial-ledger-dump", "utf8");
    const encrypted = encryptBackupBufferAes256Gcm(sample, key);
    encrypted[encrypted.length - 1] ^= 0xff;
    expect(() => decryptBackupBufferAes256Gcm(encrypted, key)).toThrow();
  });
});

