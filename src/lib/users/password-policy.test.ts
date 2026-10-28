// /change-password shows a fixed sentence for a code the action emits — and nothing for any other
// `?error=` value. The layer printed the parameter verbatim.
import { describe, expect, it } from "vitest";
import {
  PASSWORD_CHANGE_ERROR_CODES,
  PASSWORD_CHANGE_MESSAGES,
  PasswordChangeError,
  passwordChangeMessage,
  passwordSchema,
} from "./password-policy";
import { DomainError } from "@/lib/domain-error";

describe("parola değişikliği hata kodları", () => {
  it("her kodun Türkçe, sabit bir metni var", () => {
    for (const code of PASSWORD_CHANGE_ERROR_CODES) {
      expect(PASSWORD_CHANGE_MESSAGES[code].length, code).toBeGreaterThan(10);
      expect(passwordChangeMessage(code)).toBe(PASSWORD_CHANGE_MESSAGES[code]);
    }
  });

  it("tanınmayan ya da boş değer hiçbir metin üretmez (URL'den serbest metin yok)", () => {
    for (const value of [undefined, null, "", "Mevcut parola hatalı.", "<script>alert(1)</script>", "INVALID_OLD", "toString"]) {
      expect(passwordChangeMessage(value), String(value)).toBeNull();
    }
  });

  it("PasswordChangeError bir DomainError: kodu ve metni taşır", () => {
    const e = new PasswordChangeError("locked");
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe("locked");
    expect(e.message).toBe(PASSWORD_CHANGE_MESSAGES.locked);
  });

  it("parola tabanı 12 karakter (seed-admin ile aynı kural)", () => {
    expect(passwordSchema.safeParse("a".repeat(11)).success).toBe(false);
    expect(passwordSchema.safeParse("a".repeat(12)).success).toBe(true);
  });
});
