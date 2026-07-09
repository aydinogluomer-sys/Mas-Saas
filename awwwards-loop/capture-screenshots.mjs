import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const outDir = path.join("awwwards-loop", "iterations");
fs.mkdirSync(outDir, { recursive: true });

const baseUrl = process.env.BASE_URL ?? "http://localhost:3001";
const prefix = process.argv[2] ?? process.env.SCREENSHOT_PREFIX ?? "baseline";
const routeFilter = process.argv[3];
const viewports = [
  ["desktop", 1366, 900],
  ["tablet", 768, 1024],
  ["mobile", 375, 812],
];
const allRoutes = [
  ["/", "home"],
  ["/admin", "admin"],
];
const routes = routeFilter ? allRoutes.filter(([route]) => route === routeFilter) : allRoutes;

const browser = await chromium.launch({ headless: true });
for (const [name, width, height] of viewports) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  for (const [route, slug] of routes) {
    await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("main", { timeout: 60000 });
    await page.waitForFunction(
      () => (document.querySelector("main")?.textContent ?? "").trim().length > 20,
      { timeout: 60000 },
    );
    await page.waitForTimeout(250);
    const file = path.join(outDir, `${prefix}-${name}-${slug}.png`);
    await page.screenshot({ path: file, fullPage: false });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    console.log(`${name} ${route} ${page.url()} overflow=${overflow} file=${file}`);
  }
  await page.close();
}
await browser.close();
