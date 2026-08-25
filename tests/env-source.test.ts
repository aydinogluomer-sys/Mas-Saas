import { describe, expect, it } from "vitest";
import {
  CONNECTION_ENV_NAMES,
  classifyEnvSource,
  connectionTargetLabel,
  connectionTargetParts,
  describeEnvSource,
  formatIntendedTargetIdentity,
  formatTargetIdentity,
  inspectEnvSource,
  inspectEnvSources,
  shadowedNames,
} from "../scripts/db/env-source";

/**
 * AŞAMA 11 / B5 — environment shadowing kapısının saf yüklemleri.
 *
 * NEDEN SAF YÜKLEM AYRI TEST EDİLİYOR. CLI (`scripts/db/env-source-check.ts`) process.exit(1)
 * çağırıyor ve bir birim testten çağrılamaz; bu yüzden KARAR saf fonksiyonlara ayrıldı ve
 * gerçek kanıt burada üretiliyor — tests/disposable-target.test.ts ile aynı desen.
 *
 * ÖLÇÜLEN KUSUR (AŞAMA 11 provası): temiz kabukta ve tamamen doğru bir `.env.local` ile
 * `scripts/db/roles-verify.ts` "DATABASE_URL tanımlı değil" dedi (tsx dosyayı okumuyor);
 * kabukta YANLIŞ ama geçerli bir hedef varken aynı script 8/8 PASS + exit 0 verdi ve yanlış
 * veritabanının kullanıcı sayısını (18) doğruymuş gibi raporladı — gerçek hedefte 17 var.
 * Çıktının hiçbir yerinde veritabanı adı ya da kaynak geçmiyordu.
 */

const SHELL = "postgres://postgres:sifre@127.0.0.1:5432/mas_radar_kabuk_probe";
const FILE = "postgres://mas_radar_app:baska@127.0.0.1:5432/mas_radar_dev";

describe("env kaynağı — sınıflandırma", () => {
  it("iki taraf da boşsa TANIMSIZ", () => {
    expect(classifyEnvSource(undefined, undefined)).toBe("absent");
    // Boş dize tanımsız sayılır — owner-url.ts ile aynı kural.
    expect(classifyEnvSource("", "")).toBe("absent");
  });

  it("yalnız .env.local varsa 'env-local-only' — tsx bunu GÖRMEZ", () => {
    expect(classifyEnvSource(undefined, FILE)).toBe("env-local-only");
    expect(classifyEnvSource("", FILE)).toBe("env-local-only");
  });

  it("yalnız kabukta varsa 'shell-only'", () => {
    expect(classifyEnvSource(SHELL, undefined)).toBe("shell-only");
    expect(classifyEnvSource(SHELL, "")).toBe("shell-only");
  });

  it("ikisi de aynıysa gölgeleme YOK", () => {
    expect(classifyEnvSource(FILE, FILE)).toBe("shell-matches-env-local");
  });

  it("ikisi farklıysa GÖLGELEME — kazanan kabuktur", () => {
    expect(classifyEnvSource(SHELL, FILE)).toBe("shell-shadows-env-local");
  });
});

describe("env kaynağı — hedef etiketi parolayı ASLA taşımaz", () => {
  it("kullanıcı@veritabanı döner", () => {
    expect(connectionTargetLabel(FILE)).toBe("mas_radar_app@mas_radar_dev");
    expect(connectionTargetLabel(SHELL)).toBe("postgres@mas_radar_kabuk_probe");
  });

  it("etikette parola geçmiyor", () => {
    const label = connectionTargetLabel(SHELL) ?? "";
    expect(label).not.toContain("sifre");
    expect(label).not.toContain("127.0.0.1");
    expect(label).not.toContain("5432");
  });

  it("parola yüzde-kaçışlıysa bile sızmıyor", () => {
    const label = connectionTargetLabel("postgres://u:p%40ss%3Aword@h:5432/db_probe") ?? "";
    expect(label).toBe("u@db_probe");
    expect(label).not.toContain("ss");
  });

  it("ayrıştırılamayan/eksik dizede undefined — ham dize DÖNMEZ", () => {
    expect(connectionTargetLabel(undefined)).toBeUndefined();
    expect(connectionTargetLabel("")).toBeUndefined();
    expect(connectionTargetLabel("bu bir url degil")).toBeUndefined();
    // Veritabanı adı yoksa etiket üretilmez.
    expect(connectionTargetLabel("postgres://u:p@h:5432/")).toBeUndefined();
  });
});

/**
 * AŞAMA 20 / P2 — kapı çıktısındaki kimlik satırı.
 *
 * ÖLÇÜLEN KUSUR (AŞAMA 11 / B5-2): `db:roles:verify` YANLIŞ bir veritabanına karşı
 * "8/8 kontrol geçti" yazdı ve exit 0 verdi. Yanlışlığı yalnız DIŞARIDAN alınan bir satır
 * sayımı (18 ≠ 17) ortaya çıkardı; kapının çıktısında hedefin adı geçmiyordu. Bu blok,
 * satırın hem ÜRETİLDİĞİNİ hem de parola/host taşımadığını sabitler.
 */
describe("kimlik satırı — hedefi söyler, sırrı söylemez", () => {
  it("ölçülen db + user tek satırda", () => {
    expect(formatTargetIdentity("mas_radar_dev", "mas_radar_app")).toBe(
      "Hedef: db=mas_radar_dev user=mas_radar_app",
    );
  });

  it("eksik değer uydurulmuyor — '(bilinmiyor)' yazılır", () => {
    expect(formatTargetIdentity(undefined, undefined)).toBe("Hedef: db=(bilinmiyor) user=(bilinmiyor)");
    expect(formatTargetIdentity("", "")).toBe("Hedef: db=(bilinmiyor) user=(bilinmiyor)");
  });

  it("bağlanılamayan kolda NİYET EDİLEN hedef yazılır, ham dize değil", () => {
    const line = formatIntendedTargetIdentity(SHELL);
    expect(line).toBe("Hedef (bağlanılamadı): db=mas_radar_kabuk_probe user=postgres");
    expect(line).not.toContain("sifre");
    expect(line).not.toContain("127.0.0.1");
    expect(line).not.toContain("5432");
  });

  it("ayrıştırılamayan dizede bile ham dize sızmıyor", () => {
    expect(formatIntendedTargetIdentity("bu bir url degil")).toBe(
      "Hedef (bağlanılamadı): db=(okunamadı) user=(okunamadı)",
    );
    expect(formatIntendedTargetIdentity(undefined)).toContain("(okunamadı)");
  });

  it("parçalayıcı ile etiket AYNI ayrıştırmayı paylaşıyor (kopya mantık yok)", () => {
    const parts = connectionTargetParts(FILE);
    expect(parts).toEqual({ user: "mas_radar_app", database: "mas_radar_dev" });
    expect(connectionTargetLabel(FILE)).toBe(`${parts?.user}@${parts?.database}`);
  });
});

describe("env kaynağı — bulgu ve açıklama", () => {
  it("gölgeleme bulgusu shadowed=true ve iki hedefi de taşır", () => {
    const finding = inspectEnvSource("DATABASE_URL", SHELL, FILE);
    expect(finding.shadowed).toBe(true);
    expect(finding.shellTarget).toBe("postgres@mas_radar_kabuk_probe");
    expect(finding.fileTarget).toBe("mas_radar_app@mas_radar_dev");
  });

  it("yalnızca gölgeleme alarm sayılır", () => {
    expect(inspectEnvSource("DATABASE_URL", FILE, FILE).shadowed).toBe(false);
    expect(inspectEnvSource("DATABASE_URL", SHELL, undefined).shadowed).toBe(false);
    expect(inspectEnvSource("DATABASE_URL", undefined, FILE).shadowed).toBe(false);
    expect(inspectEnvSource("DATABASE_URL", undefined, undefined).shadowed).toBe(false);
  });

  it("açıklama metni değeri değil KAYNAĞI söyler", () => {
    const text = describeEnvSource(inspectEnvSource("DATABASE_URL", SHELL, FILE));
    expect(text).toContain("GÖLGELEME");
    expect(text).toContain("Kazanan KABUK");
    expect(text).toContain("mas_radar_kabuk_probe");
    expect(text).not.toContain("sifre");
    expect(text).not.toContain("baska");
  });

  it("yalnız .env.local durumunda tsx'in dosyayı okumadığı AÇIKÇA söylenir", () => {
    const text = describeEnvSource(inspectEnvSource("MIGRATION_DATABASE_URL", undefined, FILE));
    expect(text).toContain("OKUMAZ");
  });

  it("her sınıf için bir açıklama var (eksik kol yok)", () => {
    const cases: Array<[string | undefined, string | undefined]> = [
      [undefined, undefined], [undefined, FILE], [SHELL, undefined], [FILE, FILE], [SHELL, FILE],
    ];
    for (const [shell, file] of cases) {
      const text = describeEnvSource(inspectEnvSource("DATABASE_URL", shell, file));
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("undefined");
    }
  });
});

describe("env kaynağı — toplu rapor", () => {
  it("cutover'ın iki bağlantı değişkenini izler", () => {
    expect(CONNECTION_ENV_NAMES).toEqual(["MIGRATION_DATABASE_URL", "DATABASE_URL"]);
  });

  it("gölgelenen adlar listelenir, sıra korunur", () => {
    const findings = inspectEnvSources(
      CONNECTION_ENV_NAMES,
      { MIGRATION_DATABASE_URL: SHELL, DATABASE_URL: FILE },
      { MIGRATION_DATABASE_URL: FILE, DATABASE_URL: FILE },
    );
    expect(findings.map((f) => f.name)).toEqual(["MIGRATION_DATABASE_URL", "DATABASE_URL"]);
    expect(shadowedNames(findings)).toEqual(["MIGRATION_DATABASE_URL"]);
  });

  it("temiz ortamda gölgelenen ad yok", () => {
    const findings = inspectEnvSources(
      CONNECTION_ENV_NAMES,
      { MIGRATION_DATABASE_URL: FILE, DATABASE_URL: FILE },
      { MIGRATION_DATABASE_URL: FILE, DATABASE_URL: FILE },
    );
    expect(shadowedNames(findings)).toEqual([]);
  });
});
