import { describe, expect, it } from "vitest";
import {
  buildTotpOtpAuthUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpCodeAt,
  generateTotpSecret,
  verifyTotpCode,
} from "./totp";

describe("RFC 6238 TOTP & AES-256-GCM Secret Vault (M-68)", () => {
  it("generates a valid Base32 secret and verifies codes across ±1 time step", () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBeGreaterThanOrEqual(32);

    const fixedNow = 1_750_000_000_000;
    const code = generateTotpCodeAt(secret, fixedNow);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(secret, code, fixedNow)).toBe(true);
    expect(verifyTotpCode(secret, code, fixedNow + 25_000)).toBe(true); // within ±1 step
    expect(verifyTotpCode(secret, "000000", fixedNow) && code !== "000000").toBe(false);
  });

  it("encrypts and decrypts TOTP secrets with AES-256-GCM integrity", () => {
    const secret = generateTotpSecret();
    const enc = encryptTotpSecret(secret);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptTotpSecret(enc)).toBe(secret);

    const uri = buildTotpOtpAuthUri({ secretBase32: secret, accountName: "admin" });
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain(`secret=${secret}`);
  });
});

