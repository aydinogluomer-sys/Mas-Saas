// PWA manifest, icon, and service-worker retirement checks.
//
// Wave 0 / S6 replaced the unreviewed caching worker with a one-release kill-switch;
// Wave 2A completes the planned retirement (docs/todo.md:300-302): public/sw.js and
// src/components/pwa/service-worker-cleanup.tsx are deleted, middleware no longer exempts sw.js,
// manifest/viewport theme colors match the archival cotton-parchment palette (#F3EBDC),
// and zero files in src/ register a service worker or write to Cache Storage.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf-8");

/** Source without // line comments and block comments — what actually runs. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) ? [rel] : [];
  });
}

describe("PWA Assets & Configuration", () => {
  it("has a valid public/manifest.json conforming to PWA spec and warm parchment theme", () => {
    const manifestPath = path.join(ROOT, "public", "manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifestContent = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifestContent.name).toBe("MAS Nakit Radar");
    expect(manifestContent.short_name).toBe("MAS Radar");
    expect(manifestContent.display).toBe("standalone");
    expect(manifestContent.start_url).toBe("/");
    expect(manifestContent.theme_color).toBe("#F3EBDC");
    expect(manifestContent.background_color).toBe("#F3EBDC");
    expect(Array.isArray(manifestContent.icons)).toBe(true);
    expect(manifestContent.icons.length).toBeGreaterThan(0);
    expect(manifestContent.icons[0].src).toBe("/icon.svg");
  });

  it("manifest no longer points anywhere under the removed Telegram mini-app", () => {
    const raw = read("public/manifest.json");
    expect(raw).not.toContain("/telegram/miniapp");
  });

  it("has a high-resolution icon.svg asset in public directory", () => {
    const iconPath = path.join(ROOT, "public", "icon.svg");
    expect(fs.existsSync(iconPath)).toBe(true);
    const iconContent = fs.readFileSync(iconPath, "utf-8");
    expect(iconContent).toContain("<svg");
  });
});

describe("service worker — emeklilik tamamlandı, hiçbir sayfa önbelleğe alınmaz (Wave 0 / S6)", () => {
  it("public/sw.js, pwa-register.tsx ve service-worker-cleanup.tsx tamamen kaldırılmıştır", () => {
    expect(fs.existsSync(path.join(ROOT, "public", "sw.js"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "src", "components", "pwa", "pwa-register.tsx"))).toBe(false);
    expect(
      fs.existsSync(path.join(ROOT, "src", "components", "pwa", "service-worker-cleanup.tsx")),
    ).toBe(false);
  });

  it("src/middleware.ts artık sw.js yolunu oturum kontrolünden muaf tutmaz", () => {
    const middlewareCode = codeOnly(read("src/middleware.ts"));
    expect(middlewareCode).not.toMatch(/sw\\?\.js/);
  });

  it("src/app/layout.tsx manifest bağlantısını ve #F4F1EA temasını korur; SW bileşenlerini bağlamaz", () => {
    const layout = codeOnly(read("src/app/layout.tsx"));
    expect(layout).toMatch(/manifest:\s*["']\/manifest\.json["']/);
    expect(layout).toMatch(/themeColor:\s*["']#F4F1EA["']/);
    expect(layout).not.toMatch(/PwaRegister/);
    expect(layout).not.toMatch(/ServiceWorkerCleanup/);
  });

  it("src/ içinde hiçbir kod service worker KAYDETMEZ ya da Cache Storage'a yazmaz", () => {
    const offenders = sourceFiles("src").filter((rel) => {
      const code = codeOnly(read(rel));
      return /serviceWorker\s*\.\s*register\s*\(/.test(code) || /caches\.open\s*\(/.test(code);
    });
    expect(offenders).toEqual([]);
  });
});

describe("robots.txt — özel uygulama, dizine eklenmez", () => {
  it("her şeyi her tarayıcı için yasaklar", async () => {
    const { default: robots } = await import("@/app/robots");
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    expect(rules).toHaveLength(1);
    expect(rules[0].userAgent).toBe("*");
    expect(rules[0].disallow).toBe("/");
    expect(rules[0].allow).toBeUndefined();
  });
});
