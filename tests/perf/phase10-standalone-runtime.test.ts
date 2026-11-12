import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  prepareStandaloneAssets,
  resolveDistDir,
  resolveLaunchMode,
  resolveRuntimeBind,
  resolveStandaloneLayout,
} from "../../scripts/ops/start-standalone";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

describe("Faz 10 — Next.js minimal/standalone üretim sunucusu ve bellek disiplini", () => {
  it(
    "next.config.ts serverExternalPackages, daraltılmış onDemandEntries tamponu ve MAS_NEXT_STANDALONE desteğini tanımlar",
    async () => {
      const cfg = (await import("../../next.config")).default;

      if (process.platform !== "win32") {
        expect(cfg.output).toBe("standalone");
      } else {
        // Standart Windows + pnpm ortamında fs.symlink EPERM vermemesi için varsayılan undefined
        expect(cfg.output).toBeUndefined();
      }

      expect(cfg.serverExternalPackages).toEqual(
        expect.arrayContaining(["exceljs", "pg", "@node-rs/argon2"]),
      );
      expect(cfg.onDemandEntries?.pagesBufferLength).toBeLessThanOrEqual(10);
      expect(cfg.onDemandEntries?.maxInactiveAge).toBeLessThanOrEqual(5 * 60 * 1000);

      // MAS_NEXT_STANDALONE=1 verildiğinde Windows'ta da output='standalone' etkinleşir
      const prev = process.env.MAS_NEXT_STANDALONE;
      try {
        process.env.MAS_NEXT_STANDALONE = "1";
        vi.resetModules();
        const standaloneCfg = (await import("../../next.config")).default;
        expect(standaloneCfg.output).toBe("standalone");
      } finally {
        if (prev === undefined) delete process.env.MAS_NEXT_STANDALONE;
        else process.env.MAS_NEXT_STANDALONE = prev;
        vi.resetModules();
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it("package.json 'start' betiği --max-old-space-size=4096 içermez ve minimal üretim başlatıcısını çağırır", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    const startCmd = pkg.scripts.start ?? "";
    expect(startCmd).toContain("scripts/ops/runtime-port-guard.ts --start");
    expect(startCmd).toContain("scripts/db/ensure.ts");
    expect(startCmd).toContain("scripts/prepare-runtime.ts");
    expect(startCmd).toContain("scripts/ops/start-standalone.ts");
    expect(startCmd).not.toContain("--max-old-space-size=4096");
    expect(startCmd).not.toContain("next start");
    expect(
      existsSync(path.join(process.cwd(), "scripts", "ops", "minimal-next-server.mjs")),
    ).toBe(true);
  });

  it("start-standalone hem Windows minimal-in-place (required-server-files.json) hem standalone-dir (server.js) modlarını doğrular", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "mas-standalone-verify-"));
    try {
      const distDir = resolveDistDir({ MAS_NEXT_DIST_DIR: ".next-custom" });
      expect(distDir).toBe(".next-custom");

      const layout = resolveStandaloneLayout(tempRoot, distDir);

      // Derleme çıktısı yokken anlamlı hata vermeli
      expect(() => prepareStandaloneAssets(layout)).toThrow(/Üretim derlemesi bulunamadı/);

      // 1) Windows + pnpm standart derleme çıktısı: required-server-files.json mevcut
      mkdirSync(layout.distPath, { recursive: true });
      writeFileSync(
        layout.requiredServerFiles,
        JSON.stringify({ version: 1, config: { distDir } }),
        "utf8",
      );
      expect(resolveLaunchMode(layout)).toBe("minimal-in-place");
      expect(prepareStandaloneAssets(layout)).toEqual({
        mode: "minimal-in-place",
        staticCopied: false,
        publicCopied: false,
      });

      // 2) Tam standalone dizini mevcutsa (Linux / MAS_NEXT_STANDALONE=1): static + public kopyalanır
      mkdirSync(layout.standaloneDir, { recursive: true });
      writeFileSync(layout.serverEntry, "// standalone server stub\n", "utf8");

      mkdirSync(path.join(layout.sourceStaticDir, "chunks"), { recursive: true });
      writeFileSync(
        path.join(layout.sourceStaticDir, "chunks", "app.js"),
        "console.log('chunk');",
        "utf8",
      );

      mkdirSync(layout.sourcePublicDir, { recursive: true });
      writeFileSync(
        path.join(layout.sourcePublicDir, "favicon.ico"),
        "icon-bytes",
        "utf8",
      );

      expect(resolveLaunchMode(layout)).toBe("standalone-dir");
      const copyResult = prepareStandaloneAssets(layout);
      expect(copyResult).toEqual({
        mode: "standalone-dir",
        staticCopied: true,
        publicCopied: true,
      });

      expect(
        existsSync(path.join(layout.targetStaticDir, "chunks", "app.js")),
      ).toBe(true);
      expect(
        existsSync(path.join(layout.targetPublicDir, "favicon.ico")),
      ).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolveRuntimeBind varsayılan olarak kapalı devre 127.0.0.1:3000 adresine bağlanır ve bayrakları onurlandırır", () => {
    expect(resolveRuntimeBind([], {})).toEqual({
      hostname: "127.0.0.1",
      port: "3000",
    });
    expect(resolveRuntimeBind(["--port", "3250"], { HOSTNAME: "127.0.0.1" })).toEqual({
      hostname: "127.0.0.1",
      port: "3250",
    });
    expect(resolveRuntimeBind([], { PORT: "3103" })).toEqual({
      hostname: "127.0.0.1",
      port: "3103",
    });
  });
});
