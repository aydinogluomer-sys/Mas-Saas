/**
 * Wave 0 KEEP özelliklerinin etkileşim manifestosunda karşılığı var mı — Playwright'sız.
 *
 * Etkileşim kapısı (scripts/qa/interaction-coverage-gate.ts) manifestosuz bir kontrolü HER modda
 * kırmızı sayar, ama bunu yalnız CI'da, production derlemesi + tarama + Playwright koştuktan sonra
 * söyler. Zorunlu parola değişikliği (0095) Wave 0'da tutuldu ve /system/security'deki
 * "şifre değişimi zorla" düğmesi her satırda render edildiği halde manifestoda kuralı yoktu: ilk
 * CI koşusu ratchet kapısında kırmızı olacaktı ve yerelde bunu söyleyen hiçbir şey yoktu.
 *
 * Bu dosya aynı kararı (ruleFor) kaynak düzeyinde verir: etiket sayfada render ediliyor, manifesto
 * onu bir mutation kuralına bağlıyor ve o kuralın işaret ettiği tıkla-ve-DB-doğrula vakası var.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ruleFor } from "./interaction/manifest";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

describe("etkileşim manifestosu — /system/security 'şifre değişimi zorla' (KEEP, 0095)", () => {
  const LABEL = "şifre değişimi zorla";

  it("sayfa bu etiketi gerçekten render ediyor (etiket değişirse kural da değişmeli)", () => {
    const page = read("src/app/(dashboard)/system/security/page.tsx");
    expect(page).toContain(LABEL);
    expect(page).toContain("forcePasswordChangeAction");
  });

  it("taramanın göreceği <button> bir mutation kuralına eşlenir — 'manifestosuz' değildir", () => {
    const rule = ruleFor({ route: "/system/security", label: LABEL, tag: "button", href: null });
    expect(rule?.id).toBe("system/force-password-change");
    expect(rule?.klass).toBe("mutation");
    expect(rule?.dbEffect).toMatch(/must_change_password/);
  });

  it("kural yalnız kendi rotasında eşleşir (başka bir sayfadaki aynı metin bu kanıtı ödünç alamaz)", () => {
    expect(ruleFor({ route: "/system", label: LABEL, tag: "button", href: null })?.id)
      .not.toBe("system/force-password-change");
  });

  it("kuralın işaret ettiği tıkla-ve-DB-doğrula vakası mutations.spec.ts'te var ve fixture kullanıcısında koşar", () => {
    const rule = ruleFor({ route: "/system/security", label: LABEL, tag: "button", href: null });
    expect(rule?.verifiedBy).toMatch(/^mutations\.spec\.ts › system\/force-password-change/);
    const spec = read("tests/interaction/mutations.spec.ts");
    expect(spec).toContain(`id: "system/force-password-change"`);
    expect(spec).toContain(`label: "${LABEL}"`);
    // Görsel rol kullanıcılarına değil, ayrılmış fixture'a basılır (aksi hâlde o rolün sonraki her
    // isteği /change-password'e düşer).
    expect(spec).toContain("setup: ensureForceChangeFixtureUser");
  });

  it("görsel harness her koşuda bayrağı sıfırlar (yeniden kullanılan test DB'si oturumları kilitlemez)", () => {
    const setup = read("tests/visual/global-setup.ts");
    expect(setup).toMatch(/must_change_password = false/);
  });
});
