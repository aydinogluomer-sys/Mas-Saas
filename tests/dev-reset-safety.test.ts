import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "./setup/test-timeouts";

/**
 * scripts/db/dev-reset.sh — fail-closed yıkım kapısı.
 *
 * NEDEN BU TESTLER MOCK'LU. Kanıtlanması gereken şey "script gerçekten DROP edebiliyor mu"
 * DEĞİL — bunu doğrulamanın tek yolu gerçek mas_radar_dev'i silmek olurdu ve bu, testin
 * korumaya çalıştığı şeyin ta kendisidir. Kanıtlanması gereken KAPININ KARARI: hangi
 * girdilerde yıkıcı komuta ULAŞILIYOR, hangilerinde ulaşılmıyor.
 *
 * Bu yüzden PATH'e sahte bir `docker` konuyor. Sahte docker her çağrısını bir log dosyasına
 * yazıp 0 ile çıkıyor; böylece komut DİZİSİ ölçülebiliyor ve hiçbir gerçek veritabanı
 * etkilenmiyor. `ensure.sh` de yalnız docker çağırdığı için o da tamamen etkisizleşiyor.
 *
 * Negatif vakalarda aranan şey "exit 9" değil yalnızca — log'da `dropdb` GEÇMEMESİ. Yanlış
 * sırayla yazılmış bir kapı doğru exit kodunu döndürüp yine de silmiş olabilirdi.
 */

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = "scripts/db/dev-reset.sh";
const FLAG = "--i-understand-this-destroys-mas-radar-dev";
const DB = "mas_radar_dev";

let sandbox: string;
let dockerLog: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "devreset-"));
  dockerLog = path.join(sandbox, "docker-calls.log");
  // Sahte docker: argümanlarını log'lar, hiçbir şey yapmaz, 0 döner.
  const fake = path.join(sandbox, "docker");
  // MOCK_ABORT_ON: sahte docker o alt-komutta 1 döner. Pozitif testte kullanılıyor — kapı
  // geçtikten SONRA script'i hemen durdurur, böylece 87 migration dosyası sahte docker üzerinden
  // tek tek oynatılmaz (ölçüldü: ~6 sn/koşu). Test edilen özellik zaten "yıkıcı komuta ULAŞILDI
  // mı", komutun sonuna kadar koşup koşmadığı değil.
  writeFileSync(
    fake,
    [
      "#!/usr/bin/env bash",
      `echo "$@" >> "${dockerLog.split(path.sep).join("/")}"`,
      'if [ -n "${MOCK_ABORT_ON:-}" ]; then',
      '  for a in "$@"; do [ "$a" = "$MOCK_ABORT_ON" ] && exit 1; done',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fake, 0o755);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface Run {
  status: number;
  stderr: string;
  stdout: string;
  dockerCalls: string;
}

function resolveBash(): string {
  if (process.platform === "win32") {
    try {
      const gitCmd = execFileSync("where.exe", ["git"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
      if (gitCmd) {
        const gitDir = path.dirname(path.dirname(gitCmd));
        const binBash = path.join(gitDir, "bin", "bash.exe");
        if (existsSync(binBash)) return binBash;
        const usrBinBash = path.join(gitDir, "usr", "bin", "bash.exe");
        if (existsSync(usrBinBash)) return usrBinBash;
      }
    } catch {
      // ignore
    }
    const commonPaths = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    ];
    for (const p of commonPaths) {
      if (existsSync(p)) return p;
    }
  }
  return "bash";
}

/**
 * Her çağrı gerçek bir Git Bash süreci başlatır (Windows'ta önce `where.exe git`). Bu yüzden onu
 * çağıran her test SUBPROCESS_TEST_TIMEOUT_MS'i üçüncü argüman olarak alır: pozitif vaka yük altında
 * 9,2 sn ölçüldü ve 5 sn'lik varsayılanda düştü. Süreç başlatmayan kaynak sözleşmesi testleri
 * varsayılanda kalır. Gerekçe: tests/setup/test-timeouts.ts.
 */
function runReset(args: string[], env: Record<string, string | undefined>): Run {
  let status = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(resolveBash(), [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"], // TTY yok -> interaktif katman atlanır, flag+env taşır
      env: {
        ...process.env,
        ...env,
        PATH: `${sandbox}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    status = err.status ?? -1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }
  return {
    status,
    stdout,
    stderr,
    dockerCalls: existsSync(dockerLog) ? readFileSync(dockerLog, "utf8") : "",
  };
}

describe("dev-reset.sh — varsayılan olarak HİÇBİR ŞEY silmez", () => {
  it("çıplak çağrı: exit 9 ve dropdb'ye ULAŞILMAZ", () => {
    const r = runReset([], { MAS_ALLOW_DEV_DB_RESET: undefined });
    expect(r.status).toBe(9);
    expect(r.stderr).toContain("GÜVENLİK DURDURMASI");
    expect(r.dockerCalls).not.toContain("dropdb");
    // Kapı ensure.sh'tan da ÖNCE: tek bir docker çağrısı bile olmamalı.
    expect(r.dockerCalls).toBe("");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("YALNIZ bayrak yeterli değil", () => {
    const r = runReset([FLAG], { MAS_ALLOW_DEV_DB_RESET: undefined });
    expect(r.status).toBe(9);
    expect(r.dockerCalls).not.toContain("dropdb");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("YALNIZ env değişkeni yeterli değil", () => {
    const r = runReset([], { MAS_ALLOW_DEV_DB_RESET: DB });
    expect(r.status).toBe(9);
    expect(r.dockerCalls).not.toContain("dropdb");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("env değişkeni YANLIŞ değerle yeterli değil", () => {
    const r = runReset([FLAG], { MAS_ALLOW_DEV_DB_RESET: "yes" });
    expect(r.status).toBe(9);
    expect(r.dockerCalls).not.toContain("dropdb");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("benzer ama farklı bir bayrak kabul edilmez", () => {
    const r = runReset(["--force", "--yes", "-f"], { MAS_ALLOW_DEV_DB_RESET: DB });
    expect(r.status).toBe(9);
    expect(r.dockerCalls).not.toContain("dropdb");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("hata mesajı eksik olan onayı ADIYLA söyler", () => {
    const r = runReset([], { MAS_ALLOW_DEV_DB_RESET: undefined });
    expect(r.stderr).toContain(FLAG);
    expect(r.stderr).toContain("MAS_ALLOW_DEV_DB_RESET=" + DB);
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});

describe("dev-reset.sh — iki onay birlikte verildiğinde geçer", () => {
  // Tek koşu, iki iddia: sahte docker `dropdb`de durduğu için hızlı, ve kapının kararını
  // (yıkıcı komuta ULAŞILDI) tam olarak ölçüyor. Gerçek mas_radar_dev'e dokunulmuyor.
  it("bayrak + env: yıkıcı komuta ULAŞILIR ve önce ölçülen kimlik raporlanır", () => {
    const r = runReset([FLAG], { MAS_ALLOW_DEV_DB_RESET: DB, MOCK_ABORT_ON: "dropdb" });

    // Kapı geçti: dropdb çağrıldı. (Çıkış kodu sahte docker'ın 1'i, kapının 9'u DEĞİL.)
    expect(r.dockerCalls).toContain("dropdb");
    expect(r.dockerCalls).toContain(DB);
    expect(r.status).not.toBe(9);

    // Ve yıkımdan önce operatöre ne sileceği gösterildi.
    expect(r.stdout).toContain("YIKIM ÖNCESİ ÖLÇÜLEN KİMLİK");
    expect(r.stdout).toContain("container");
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});

describe("dev-reset.sh — kaynak sözleşmesi", () => {
  const src = readFileSync(path.join(ROOT, SCRIPT), "utf8");
  const lineOf = (re: RegExp): number => {
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*#/.test(lines[i])) continue;
      if (re.test(lines[i])) return i + 1;
    }
    return Number.POSITIVE_INFINITY;
  };

  it("exit 9, ilk dropdb'den ÖNCE gelir", () => {
    expect(lineOf(/exit 9/)).toBeLessThan(lineOf(/dropdb/));
  });

  it("kapı, ensure.sh çağrısından ÖNCE gelir", () => {
    expect(lineOf(/exit 9/)).toBeLessThan(lineOf(/ensure\.sh/));
  });
});
