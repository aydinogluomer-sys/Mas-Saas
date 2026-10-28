// PWA manifest, icon and service worker — the static assets the browser installs from.
//
// Moved out of tests/telegram-miniapp.test.ts when Wave 0 removed the Telegram mini-app (R1):
// the mini-app engine and its write-action tests went with it, these asset checks did not belong
// to it. The manifest keeps its install metadata and icon; its shortcut to /telegram/miniapp is
// gone, because a shortcut to a page that no longer exists is a dead tile on the home screen.
//
// Wave 0 / S6 turned the service-worker check around. The layer's worker cached every financial
// page the user opened and served it offline and after logout; this file used to assert that it
// HAD fetch and push handlers. It now asserts the rule instead: no page is ever cached. sw.js is a
// one-release kill-switch (clean up, then unregister) and nothing in src/ registers a worker.
// The source checks strip comments first — the kill-switch explains in prose what it does NOT do,
// and a test that matched its own explanation would prove nothing.
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
  it("has a valid public/manifest.json conforming to PWA spec", () => {
    const manifestPath = path.join(ROOT, "public", "manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifestContent = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifestContent.name).toBe("MAS Nakit Radar");
    expect(manifestContent.short_name).toBe("MAS Radar");
    expect(manifestContent.display).toBe("standalone");
    expect(manifestContent.start_url).toBe("/");
    expect(manifestContent.theme_color).toBe("#0284c7");
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

describe("service worker — hiçbir sayfa önbelleğe alınmaz (Wave 0 / S6)", () => {
  const sw = codeOnly(read("public/sw.js"));

  it("sw.js bir kill-switch: fetch ya da push dinleyicisi yok", () => {
    // A worker without a fetch handler answers nothing; every request goes to the network.
    expect(sw).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(sw).not.toMatch(/addEventListener\(\s*["']push["']/);
    expect(sw).not.toMatch(/addEventListener\(\s*["']notificationclick["']/);
    expect(sw).not.toMatch(/\bonfetch\b|\bonpush\b/);
  });

  it("sw.js hiçbir şeyi önbelleğe yazmaz", () => {
    expect(sw).not.toMatch(/caches\.open\s*\(/);
    expect(sw).not.toMatch(/\.put\s*\(/);
    expect(sw).not.toMatch(/\.addAll\s*\(/);
    expect(sw).not.toMatch(/\.add\s*\(/);
  });

  it("sw.js etkinleşince bütün önbellekleri siler ve kendi kaydını kaldırır", () => {
    expect(sw).toMatch(/addEventListener\(\s*["']install["']/);
    expect(sw).toMatch(/skipWaiting\s*\(\s*\)/);
    expect(sw).toMatch(/addEventListener\(\s*["']activate["']/);
    expect(sw).toMatch(/clients\.claim\s*\(\s*\)/);
    expect(sw).toMatch(/caches\.keys\s*\(\s*\)/);
    expect(sw).toMatch(/caches\.delete\s*\(/);
    expect(sw).toMatch(/registration\.unregister\s*\(\s*\)/);
  });

  it("src/ içinde hiçbir kod service worker KAYDETMEZ ya da Cache Storage'a yazmaz", () => {
    const offenders = sourceFiles("src").filter((rel) => {
      const code = codeOnly(read(rel));
      return /serviceWorker\s*\.\s*register\s*\(/.test(code) || /caches\.open\s*\(/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("katmanın kayıt bileşeni (kurulum bandı + 'çevrimdışı destek' vaadi) yok", () => {
    expect(fs.existsSync(path.join(ROOT, "src", "components", "pwa", "pwa-register.tsx"))).toBe(false);
  });

  it("temizlik bileşeni kayıtları kaldırır, önbellekleri siler ve kök layout'ta takılı", () => {
    const cleanup = codeOnly(read("src/components/pwa/service-worker-cleanup.tsx"));
    expect(cleanup).toMatch(/getRegistrations\s*\(\s*\)/);
    expect(cleanup).toMatch(/\.unregister\s*\(\s*\)/);
    expect(cleanup).toMatch(/caches\s*\.keys\s*\(\s*\)/);
    expect(cleanup).toMatch(/caches\.delete\s*\(/);

    const layout = codeOnly(read("src/app/layout.tsx"));
    expect(layout).toMatch(/<ServiceWorkerCleanup\s*\/>/);
    expect(layout).not.toMatch(/PwaRegister/);
    // The install metadata stays: manifest and icon are not a cache.
    expect(layout).toMatch(/manifest:\s*["']\/manifest\.json["']/);
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
