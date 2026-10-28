// /change-password's server action — what leaves it, and in what form.
//
// The unreviewed layer redirected with the raw error MESSAGE in the URL (`?error=<text>`), and
// the page printed whatever `?error=` held. Wave 0 made the URL carry only a code from a closed
// list (@/lib/users/password-policy) that the page maps to a fixed sentence. The mapping itself is
// pinned in password-policy.test.ts and the change in change-own-password.test.ts; this file pins
// the action between them, which neither of those can see:
//
//   - the session gate runs before anything is read or attempted
//   - every expected failure leaves as `?error=<code>` and nothing else
//   - an UNexpected failure (a refused audit row, a dead connection) is not dressed up as a
//     friendly message: it propagates, so it surfaces as the error it is
//   - success lands on /overview with the curated flash key the toast layer knows
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireSession: vi.fn(),
  changeOwnPassword: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/auth", () => ({
  requireSession: h.requireSession,
  changeOwnPassword: h.changeOwnPassword,
}));

import { changePasswordAction } from "./actions";
import { PASSWORD_CHANGE_ERROR_CODES, PasswordChangeError } from "@/lib/users/password-policy";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "muhasebe.ayse",
  displayName: "Ayşe",
  role: "viewer" as const,
  mustChangePassword: true,
};
const OLD = "EskiParola-2026!";
const NEW = "YepyeniParola-2026!";

function form(oldPassword: string, newPassword: string, confirmPassword: string): FormData {
  const fd = new FormData();
  fd.set("oldPassword", oldPassword);
  fd.set("newPassword", newPassword);
  fd.set("confirmPassword", confirmPassword);
  return fd;
}

/** The URL the action redirected to, or the error it threw if that was not a redirect. */
async function outcome(fd: FormData): Promise<string | Error> {
  try {
    await changePasswordAction(fd);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("REDIRECT ")) return message.slice("REDIRECT ".length);
    return e as Error;
  }
  throw new Error("eylem ne yönlendirdi ne de hata fırlattı");
}

beforeEach(() => {
  h.requireSession.mockReset().mockResolvedValue(USER);
  h.changeOwnPassword.mockReset().mockResolvedValue({ otherSessionsRevoked: 1 });
});

describe("parola değiştirme eylemi", () => {
  it("oturum kapısı her şeyden önce: zorunlu değişiklik altındaki oturuma izin verir, oturumsuzu girişe gönderir", async () => {
    await outcome(form(OLD, NEW, NEW));
    expect(h.requireSession).toHaveBeenCalledWith({ allowMustChangePassword: true });

    h.requireSession.mockReset().mockRejectedValue(new Error("REDIRECT /login"));
    expect(await outcome(form(OLD, NEW, NEW))).toBe("/login");
    expect(h.changeOwnPassword).toHaveBeenCalledTimes(1); // only the first, gated call
  });

  it("başarı: değişiklik oturum kullanıcısı adına yapılır, /overview'a bilinen flash anahtarıyla döner", async () => {
    expect(await outcome(form(OLD, NEW, NEW))).toBe("/overview?flash=password_updated");
    expect(h.changeOwnPassword).toHaveBeenCalledWith(USER, OLD, NEW);
  });

  it("tekrar eşleşmezse hiçbir şey denenmez; URL'de yalnız kod var", async () => {
    expect(await outcome(form(OLD, NEW, `${NEW}x`))).toBe("/change-password?error=mismatch");
    expect(h.changeOwnPassword).not.toHaveBeenCalled();
  });

  for (const code of PASSWORD_CHANGE_ERROR_CODES) {
    it(`beklenen hata '${code}' URL'e metin olarak değil KOD olarak çıkar`, async () => {
      h.changeOwnPassword.mockRejectedValue(new PasswordChangeError(code));
      const url = await outcome(form(OLD, NEW, NEW));
      expect(url).toBe(`/change-password?error=${code}`);
      expect(url).toMatch(/^\/change-password\?error=[a-z_]+$/);
    });
  }

  it("beklenmeyen bir hata (ör. RLS'in reddettiği denetim satırı) dostça bir mesaja çevrilmez, olduğu gibi yükselir", async () => {
    const fault = Object.assign(new Error("new row violates row-level security policy"), { code: "42501" });
    h.changeOwnPassword.mockRejectedValue(fault);
    expect(await outcome(form(OLD, NEW, NEW))).toBe(fault);
  });
});
