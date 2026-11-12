import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "./setup/test-timeouts";

/**
 * scripts/db/dev-reset.sh — fail-closed yıkım kapısı (native TCP araçları, 0 docker exec).
 */

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = "scripts/db/dev-reset.sh";
const FLAG = "--i-understand-this-destroys-mas-radar-dev";
const DB = "mas_radar_dev";

let sandbox: string;
let toolLog: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "devreset-"));
  toolLog = path.join(sandbox, "pg-tool-calls.log");
  const normalizedLog = toolLog.split(path.sep).join("/");

  for (const binName of ["psql", "dropdb", "createdb"]) {
    const fake = path.join(sandbox, binName);
    writeFileSync(
      fake,
      [
        "#!/usr/bin/env bash",
        `echo "${binName} $@" >> "${normalizedLog}"`,
        `if [ "\${MOCK_ABORT_ON:-}" = "${binName}" ]; then exit 1; fi`,
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fake, 0o755);
  }
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface Run {
  status: number;
  stderr: string;
  stdout: string;
  toolCalls: string;
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

function runReset(args: string[], env: Record<string, string | undefined>): Run {
  let status = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(resolveBash(), [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MAS_SKIP_DB_ENSURE: "1",
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
    toolCalls: existsSync(toolLog) ? readFileSync(toolLog, "utf8") : "",
  };
}

describe("dev-reset.sh — varsayılan olarak HİÇBİR ŞEY silmez", () => {
  it("çıplak çağrı: exit 9 ve dropdb'ye ULAŞILMAZ", () => {
    const r = runReset([], { MAS_ALLOW_DEV_DB_RESET: undefined });
    expect(r.status).toBe(9);
    expect(r.stderr).toContain("GÜVENLİK DURDURMASI");
    expect(r.toolCalls).not.toContain("dropdb");
    expect(r.toolCalls).toBe("");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("YALNIZ bayrak yeterli değil", () => {
    const r = runReset([FLAG], { MAS_ALLOW_DEV_DB_RESET: undefined });
    expect(r.status).toBe(9);
    expect(r.toolCalls).not.toContain("dropdb");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("YALNIZ env değişkeni yeterli değil", () => {
    const r = runReset([], { MAS_ALLOW_DEV_DB_RESET: DB });
    expect(r.status).toBe(9);
    expect(r.toolCalls).not.toContain("dropdb");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("env değişkeni YANLIŞ değerle yeterli değil", () => {
    const r = runReset([FLAG], { MAS_ALLOW_DEV_DB_RESET: "yes" });
    expect(r.status).toBe(9);
    expect(r.toolCalls).not.toContain("dropdb");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("benzer ama farklı bir bayrak kabul edilmez", () => {
    const r = runReset(["--force", "--yes", "-f"], { MAS_ALLOW_DEV_DB_RESET: DB });
    expect(r.status).toBe(9);
    expect(r.toolCalls).not.toContain("dropdb");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("hata mesajı eksik olan onayı ADIYLA söyler", () => {
    const r = runReset([], { MAS_ALLOW_DEV_DB_RESET: undefined });
    expect(r.stderr).toContain(FLAG);
    expect(r.stderr).toContain("MAS_ALLOW_DEV_DB_RESET=" + DB);
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});

describe("dev-reset.sh — iki onay birlikte verildiğinde geçer", () => {
  it("bayrak + env: yıkıcı komuta ULAŞILIR ve önce ölçülen kimlik raporlanır", () => {
    const r = runReset([FLAG], { MAS_ALLOW_DEV_DB_RESET: DB, MOCK_ABORT_ON: "dropdb" });
    expect(r.toolCalls).toContain("dropdb");
    expect(r.toolCalls).toContain(DB);
    expect(r.status).not.toBe(9);
    expect(r.stdout).toContain("YIKIM ÖNCESİ ÖLÇÜLEN KİMLİK");
    expect(r.stdout).toContain("endpoint");
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
