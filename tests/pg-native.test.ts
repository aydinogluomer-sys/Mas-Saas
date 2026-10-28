/**
 * `scripts/db/pg-native.ts` — native PostgreSQL 16 araç zincirinin SAF kuralları.
 *
 * ═══ NEDEN VERİTABANSIZ ═══
 *
 * Bu modülün üç sözü var ve üçü de "hangi argv, hangi ortam" sorusu: parola komut satırına
 * yazılmaz, çocuk ortamı izin listesiyle kurulur (miras PG*, URL ve token taşınmaz), yalnız bu
 * makinedeki kümeye bağlanılır. Üçü de bir süreç başlatmadan, bir veritabanına bağlanmadan
 * kanıtlanabilir — ve kanıtlanmalı, çünkü yanlış bir cevap ancak gerçek finansal veriyle koşan
 * gece yedeğinde görünürdü.
 */
import { describe, expect, it } from "vitest";
import {
  CHILD_ENV_ALLOWLIST,
  assertPlainDbName,
  assertSameMajor,
  buildLibpqEnv,
  buildToolEnv,
  describeNativeTarget,
  describeSpawnFailure,
  parseLoopbackEndpoint,
  parseNativeTarget,
  parsePgMajor,
  redactValues,
  resolvePgBinaries,
  resolvePgRuntime,
} from "../scripts/db/pg-native";

/** Özel karakterli, yüzde-kodlanması gereken bir parola — URL'de kodlu, ortamda çözülmüş olmalı. */
const SECRET = "S3cr3t-P@ss/word%x";
const OWNER_URL = `postgres://postgres:${encodeURIComponent(SECRET)}@127.0.0.1:5432/mas_radar_dev`;

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("fırlatması beklenen çağrı fırlatmadı");
}

describe("resolvePgRuntime", () => {
  it("tanımsız ya da boş → native (operatör makinesinin varsayılanı)", () => {
    expect(resolvePgRuntime({})).toBe("native");
    expect(resolvePgRuntime({ MAS_PG_RUNTIME: "" })).toBe("native");
    expect(resolvePgRuntime({ MAS_PG_RUNTIME: "   " })).toBe("native");
  });

  it("büyük/küçük harf ve boşluk tolere edilir", () => {
    expect(resolvePgRuntime({ MAS_PG_RUNTIME: " Docker " })).toBe("docker");
    expect(resolvePgRuntime({ MAS_PG_RUNTIME: "NATIVE" })).toBe("native");
  });

  it("tanınmayan değer native'e SESSİZCE düşmez — durdurur", () => {
    expect(() => resolvePgRuntime({ MAS_PG_RUNTIME: "podman" })).toThrow(/MAS_PG_RUNTIME geçersiz/);
    expect(() => resolvePgRuntime({ MAS_PG_RUNTIME: "dokcer" })).toThrow(/MAS_PG_RUNTIME geçersiz/);
  });
});

describe("resolvePgBinaries", () => {
  const DIR = "C:\\MAS\\pgsql16\\bin";

  it("MAS_PG_BIN_DIR + hepsi mevcut → mutlak .exe yolları, kaynak MAS_PG_BIN_DIR", () => {
    const bins = resolvePgBinaries({ MAS_PG_BIN_DIR: DIR }, { exists: () => true, platform: "win32" });
    expect(bins.origin).toBe("MAS_PG_BIN_DIR");
    expect(bins.dir).toBe(DIR);
    expect(bins.pgDump).toBe(`${DIR}\\pg_dump.exe`);
    expect(bins.pgRestore).toBe(`${DIR}\\pg_restore.exe`);
    expect(bins.psql).toBe(`${DIR}\\psql.exe`);
    expect(bins.pgIsready).toBe(`${DIR}\\pg_isready.exe`);
    expect(bins.createdb).toBe(`${DIR}\\createdb.exe`);
    expect(bins.dropdb).toBe(`${DIR}\\dropdb.exe`);
  });

  it("çevreleyen tırnaklar (setx alışkanlığı) temizlenir", () => {
    const bins = resolvePgBinaries({ MAS_PG_BIN_DIR: `"${DIR}"` }, { exists: () => true, platform: "win32" });
    expect(bins.pgDump).toBe(`${DIR}\\pg_dump.exe`);
  });

  it("eksik bir araç ADIYLA raporlanır", () => {
    const msg = messageOf(() =>
      resolvePgBinaries({ MAS_PG_BIN_DIR: DIR }, { exists: (p) => !p.endsWith("pg_restore.exe"), platform: "win32" }),
    );
    expect(msg).toContain("pg_restore.exe");
    expect(msg).not.toContain("pg_dump.exe");
  });

  it("göreli dizin reddedilir (zamanlanmış görev başka bir çalışma dizininde koşar)", () => {
    expect(() => resolvePgBinaries({ MAS_PG_BIN_DIR: "pgsql16\\bin" }, { exists: () => true, platform: "win32" }))
      .toThrow(/mutlak/);
  });

  it("tanımsız → çıplak adlar, PATH'te çözülür", () => {
    const bins = resolvePgBinaries({}, { exists: () => false, platform: "win32" });
    expect(bins.origin).toBe("PATH");
    expect(bins.dir).toBeNull();
    expect(bins.pgDump).toBe("pg_dump");
    expect(bins.pgRestore).toBe("pg_restore");
  });

  it("POSIX'te uzantı eklenmez", () => {
    const bins = resolvePgBinaries({ MAS_PG_BIN_DIR: "/usr/lib/postgresql/16/bin" }, { exists: () => true, platform: "linux" });
    expect(bins.pgDump).toBe("/usr/lib/postgresql/16/bin/pg_dump");
  });
});

describe("parseLoopbackEndpoint / parseNativeTarget", () => {
  it("127.0.0.1 kabul edilir; parola yüzde-kodlaması çözülür", () => {
    const t = parseNativeTarget(OWNER_URL);
    expect(t).toEqual({ host: "127.0.0.1", port: 5432, user: "postgres", database: "mas_radar_dev", password: SECRET });
  });

  it("localhost 127.0.0.1'e normalleştirilir; port verilmezse 5432", () => {
    const t = parseNativeTarget("postgres://postgres:pw12@localhost/mas_radar_dev");
    expect(t.host).toBe("127.0.0.1");
    expect(t.port).toBe(5432);
    expect(parseLoopbackEndpoint("postgresql://u@localhost/x").wasLocalhost).toBe(true);
  });

  it("[::1] kabul edilir", () => {
    const t = parseNativeTarget("postgresql://postgres:pw12@[::1]:5433/mas_radar_dev");
    expect(t.host).toBe("::1");
    expect(t.port).toBe(5433);
  });

  it("parolasız URL'de password alanı hiç yoktur", () => {
    expect("password" in parseNativeTarget("postgres://postgres@127.0.0.1:5432/mas_radar_dev")).toBe(false);
  });

  it.each([
    ["uzak host", `postgres://postgres:${encodeURIComponent(SECRET)}@db.example.com:5432/postgres`, "db.example.com"],
    ["LAN adresi", `postgres://postgres:${encodeURIComponent(SECRET)}@10.0.0.5:5432/mas_radar_dev`, "10.0.0.5"],
    ["prototip anahtarı host", `postgres://postgres:${encodeURIComponent(SECRET)}@constructor:5432/mas_radar_dev`, "constructor"],
  ])("loopback olmayan host reddedilir (%s) — mesajda ne host ne parola", (_label, url, host) => {
    const msg = messageOf(() => parseNativeTarget(url));
    expect(msg).toMatch(/bu makine değil/);
    expect(msg).not.toContain(host);
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain(encodeURIComponent(SECRET));
  });

  it("postgres olmayan şema reddedilir, parola sızmaz", () => {
    const msg = messageOf(() => parseNativeTarget(`mysql://root:${encodeURIComponent(SECRET)}@127.0.0.1:3306/x`));
    expect(msg).toMatch(/postgres:\/\//);
    expect(msg).not.toContain(SECRET);
  });

  it("veritabanı adı yoksa reddedilir", () => {
    expect(() => parseNativeTarget("postgres://postgres:pw12@127.0.0.1:5432/")).toThrow(/düz bir tanımlayıcı değil/);
  });

  it("geçersiz port reddedilir ve URL yazdırılmaz", () => {
    expect(() => parseNativeTarget("postgres://postgres:pw12@127.0.0.1:0/mas_radar_dev")).toThrow(/port geçersiz/);
    const msg = messageOf(() => parseNativeTarget(`postgres://postgres:${SECRET}@127.0.0.1:99999/mas_radar_dev`));
    expect(msg).not.toContain(SECRET);
  });

  it("hedefi yönlendiren sorgu parametresi reddedilir", () => {
    const msg = messageOf(() => parseNativeTarget(`${OWNER_URL}?host=/tmp/evil`));
    expect(msg).toContain("'host'");
    expect(msg).not.toContain(SECRET);
  });

  it("kullanıcı adı yoksa reddedilir", () => {
    expect(() => parseNativeTarget("postgres://:pw12@127.0.0.1:5432/mas_radar_dev")).toThrow(/kullanıcı adı yok/);
  });

  it("etiket kullanıcıyı ve parolayı ASLA taşımaz", () => {
    expect(describeNativeTarget(parseNativeTarget(OWNER_URL))).toBe("native:127.0.0.1:5432");
    expect(describeNativeTarget({ host: "::1", port: 5432 })).toBe("native:[::1]:5432");
  });
});

describe("buildLibpqEnv / buildToolEnv — izin listeli çocuk ortamı", () => {
  const BASE = Object.freeze({
    PGHOST: "10.9.9.9",
    PGSERVICE: "evil",
    PGPASSFILE: "C:\\elsewhere\\pgpass",
    PGOPTIONS: "-c default_transaction_read_only=off",
    DATABASE_URL: "postgres://app:apppw@127.0.0.1:5432/mas_radar_dev",
    MIGRATION_DATABASE_URL: OWNER_URL,
    TELEGRAM_BOT_TOKEN: "123456:ABCDEF",
    OPENAI_API_KEY: "sk-not-a-real-key",
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\system32",
  });

  it("yalnız SystemRoot, PATH ve BİZİM PG* değişkenlerimiz kalır", () => {
    const env = buildLibpqEnv(parseNativeTarget(OWNER_URL), BASE);
    expect(Object.keys(env).sort()).toEqual([
      "LC_MESSAGES", "PATH", "PGAPPNAME", "PGCONNECT_TIMEOUT", "PGDATABASE", "PGHOST", "PGPASSWORD", "PGPORT", "PGUSER", "SystemRoot",
    ]);
    expect(env.PGHOST).toBe("127.0.0.1");
    expect(env.PGPORT).toBe("5432");
    expect(env.PGUSER).toBe("postgres");
    expect(env.PGDATABASE).toBe("mas_radar_dev");
    expect(env.PGPASSWORD).toBe(SECRET);
    expect(env.LC_MESSAGES).toBe("C");
    expect(env.PGOPTIONS).toBeUndefined();
  });

  it("readOnly → motor düzeyinde salt-okur oturum", () => {
    const env = buildLibpqEnv(parseNativeTarget(OWNER_URL), BASE, { readOnly: true });
    expect(env.PGOPTIONS).toBe("-c default_transaction_read_only=on");
  });

  it("veritabanı geçersiz kılma doğrulanır", () => {
    expect(buildLibpqEnv(parseNativeTarget(OWNER_URL), BASE, { database: "postgres" }).PGDATABASE).toBe("postgres");
    expect(() => buildLibpqEnv(parseNativeTarget(OWNER_URL), BASE, { database: "-f" })).toThrow(/düz bir tanımlayıcı değil/);
  });

  it("taban nesne değiştirilmez", () => {
    const snapshot = JSON.stringify(BASE);
    buildLibpqEnv(parseNativeTarget(OWNER_URL), BASE, { readOnly: true });
    expect(JSON.stringify(BASE)).toBe(snapshot);
  });

  it("parolasız hedefte PGPASSWORD hiç yazılmaz", () => {
    const env = buildLibpqEnv(parseNativeTarget("postgres://postgres@127.0.0.1:5432/mas_radar_dev"), BASE);
    expect("PGPASSWORD" in env).toBe(false);
  });

  it("Windows ortam adları büyük/küçük harfe duyarsız okunur (Path = PATH)", () => {
    const env = buildToolEnv({ Path: "C:\\bin", SYSTEMROOT: "C:\\Windows" });
    expect(env.PATH).toBe("C:\\bin");
    expect(env.SystemRoot).toBe("C:\\Windows");
  });

  it("araç ortamında HİÇBİR PG* değişkeni yok — miras PGHOST bile", () => {
    const env = buildToolEnv(BASE);
    expect(Object.keys(env).filter((k) => k.startsWith("PG"))).toEqual([]);
    expect(Object.keys(env).every((k) => k === "LC_MESSAGES" || CHILD_ENV_ALLOWLIST.includes(k))).toBe(true);
  });
});

describe("assertPlainDbName", () => {
  it("düz tanımlayıcı geçer", () => {
    expect(() => assertPlainDbName("mas_radar_dev")).not.toThrow();
    expect(() => assertPlainDbName("_x1")).not.toThrow();
    expect(() => assertPlainDbName(`a${"b".repeat(62)}`)).not.toThrow();
  });

  it.each(["-f", "a b", "x;y", "Mas", "", "1abc", `a${"b".repeat(63)}`])("'%s' reddedilir", (name) => {
    expect(() => assertPlainDbName(name)).toThrow(/düz bir tanımlayıcı değil/);
  });
});

describe("parsePgMajor / assertSameMajor", () => {
  it.each([
    ["pg_dump (PostgreSQL) 16.14", 16],
    ["pg_restore (PostgreSQL) 16.14", 16],
    ["PostgreSQL 16.14, compiled by Visual C++ build 1944, 64-bit", 16],
    ["PostgreSQL 16.4 (Debian 16.4-1.pgdg120+2) on x86_64-pc-linux-gnu", 16],
    ["160014", 16],
    ["psql (PostgreSQL) 17.2", 17],
  ])("'%s' → %i", (text, major) => {
    expect(parsePgMajor(text)).toBe(major);
  });

  it("okunamayan metin null (çağıran RED sayar)", () => {
    expect(parsePgMajor("garbage")).toBeNull();
    expect(parsePgMajor("")).toBeNull();
  });

  it("aynı ana sürüm geçer, iki yönde de fark reddedilir", () => {
    expect(() => assertSameMajor(16, 16, "pg_dump")).not.toThrow();
    expect(() => assertSameMajor(17, 16, "pg_dump")).toThrow(/pg_dump ana sürümü \(16\)/);
    expect(() => assertSameMajor(16, 17, "pg_dump")).toThrow(/sunucunun ana sürümüyle \(16\)/);
  });
});

describe("describeSpawnFailure / redactValues", () => {
  it("ENOENT operatörün yapacağı tek adıma çevrilir", () => {
    const err = Object.assign(new Error("spawn pg_dump ENOENT"), { code: "ENOENT" });
    expect(describeSpawnFailure(err, "pg_dump").message).toMatch(/pg_dump bulunamadı — MAS_PG_BIN_DIR ayarlayın/);
  });

  it("bilinen sır değerleri maskelenir; çok kısa değerler bilerek atlanır", () => {
    expect(redactValues(`FATAL: password ${SECRET} rejected`, [SECRET])).toBe("FATAL: password *** rejected");
    expect(redactValues("a1 b2", ["a1"])).toBe("a1 b2");
    expect(redactValues("x", [undefined])).toBe("x");
  });
});
