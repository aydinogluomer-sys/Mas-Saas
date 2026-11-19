// Faz 60 (M-68) — RFC 6238 TOTP (HMAC-SHA1, 6 Haneli, 30 Saniye Penceresi) İki Faktörlü Doğrulama
// ve AES-256-GCM Sır Saklama Motoru.
//
// Sıfır üçüncü parti bağımlılık — tamamen `node:crypto` ile çalışır.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function decodeBase32(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Generates a 160-bit (20-byte) Base32 TOTP secret per RFC 6238 / RFC 4226. */
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function buildTotpOtpAuthUri(params: {
  secretBase32: string;
  accountName: string;
  issuer?: string;
}): string {
  const issuer = params.issuer ?? "MAS Nakit Radar";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(params.accountName)}`;
  const qs = new URLSearchParams({
    secret: params.secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${qs.toString()}`;
}

export function generateTotpCodeAt(
  secretBase32: string,
  timestampMs = Date.now(),
  stepSeconds = 30,
): string {
  const key = decodeBase32(secretBase32);
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac("sha1", key).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const otp = binary % 1_000_000;
  return String(otp).padStart(6, "0");
}

/**
 * Verifies a 6-digit TOTP code allowing ±`windowSteps` (default ±1 step = ±30s clock drift).
 */
export function verifyTotpCode(
  secretBase32: string,
  candidateCode: string,
  timestampMs = Date.now(),
  windowSteps = 1,
): boolean {
  const cleanCode = candidateCode.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleanCode)) return false;
  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    const expected = generateTotpCodeAt(secretBase32, timestampMs + delta * 30_000);
    if (expected === cleanCode) return true;
  }
  return false;
}

function deriveTotpWrappingKey(): Buffer {
  const raw =
    process.env.MAS_TOTP_ENCRYPTION_KEY ??
    process.env.SESSION_SECRET ??
    "mas-radar-local-totp-key-material-v1";
  return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptTotpSecret(secretBase32: string): string {
  const key = deriveTotpWrappingKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptTotpSecret(encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Geçersiz TOTP sır şifreleme biçimi.");
  }
  const key = deriveTotpWrappingKey();
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

