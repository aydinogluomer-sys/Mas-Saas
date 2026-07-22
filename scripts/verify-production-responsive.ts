import { chromium } from "@playwright/test";

async function main() {
  const baseURL = process.argv[2] ?? "http://127.0.0.1:3112";
  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const viewport of [
    { width: 1366, height: 900 },
    { width: 768, height: 1024 },
    { width: 375, height: 812 },
  ]) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${baseURL}/payments`, { waitUntil: "domcontentloaded" });
    const state = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      heading: document.querySelector("h1")?.textContent?.trim() ?? null,
      hasNavigation: Boolean(document.querySelector(".app-sidebar")),
      hasChart: Boolean(document.querySelector(".analytics-chart")),
    }));
    results.push({ viewport, ...state });
    await page.close();
  }
  console.log(JSON.stringify(results));
  await browser.close();
}

void main();
