// PWA manifest, icon and service worker — the static assets the browser installs from.
//
// Moved out of tests/telegram-miniapp.test.ts when Wave 0 removed the Telegram mini-app (R1):
// the mini-app engine and its write-action tests went with it, these asset checks did not belong
// to it. The manifest keeps its install metadata and icon; its shortcut to /telegram/miniapp is
// gone, because a shortcut to a page that no longer exists is a dead tile on the home screen.
//
// The sw.js assertion below still describes the layer's caching worker. Replacing that worker with
// a non-caching cleanup worker is a separate Wave 0 step, and that step owns rewriting it.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("PWA Assets & Configuration", () => {
  it("has a valid public/manifest.json conforming to PWA spec", () => {
    const manifestPath = path.join(process.cwd(), "public", "manifest.json");
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
    const raw = fs.readFileSync(path.join(process.cwd(), "public", "manifest.json"), "utf-8");
    expect(raw).not.toContain("/telegram/miniapp");
  });

  it("has a functioning public/sw.js service worker with cache & push handlers", () => {
    const swPath = path.join(process.cwd(), "public", "sw.js");
    expect(fs.existsSync(swPath)).toBe(true);

    const swContent = fs.readFileSync(swPath, "utf-8");
    expect(swContent).toContain("addEventListener(\"install\"");
    expect(swContent).toContain("addEventListener(\"activate\"");
    expect(swContent).toContain("addEventListener(\"fetch\"");
    expect(swContent).toContain("addEventListener(\"push\"");
  });

  it("has a high-resolution icon.svg asset in public directory", () => {
    const iconPath = path.join(process.cwd(), "public", "icon.svg");
    expect(fs.existsSync(iconPath)).toBe(true);
    const iconContent = fs.readFileSync(iconPath, "utf-8");
    expect(iconContent).toContain("<svg");
  });
});
