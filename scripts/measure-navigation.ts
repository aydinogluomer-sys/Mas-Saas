import { chromium } from "@playwright/test";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const baseURL = process.argv[2] ?? process.env.BASE_URL ?? "http://127.0.0.1:3110";
  await page.goto(`${baseURL}/overview`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.navigationReady === "true");
  const routes = ["/payments", "/cashflow", "/finance", "/production", "/scenarios", "/insights/ask", "/data/quality", "/system", "/overview"];
  const results: Array<{ href: string; feedbackMs: number; routeMs: number }> = [];
  for (const href of routes) {
    const feedbackMs = await page.evaluate((target) => {
      const anchor = document.querySelector<HTMLAnchorElement>(`.sidebar-link[href="${target}"]`);
      if (!anchor) throw new Error(`Navigation link is missing: ${target}`);
      const started = performance.now();
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      const pending = document.querySelector(".navigation-pending");
      const active = anchor.getAttribute("aria-current") === "page";
      if (!pending || !active) throw new Error(`Immediate navigation feedback is missing: ${target}`);
      return performance.now() - started;
    }, href);
    const routeStarted = performance.now();
    await page.waitForURL((url) => url.pathname === href, { timeout: 30_000 });
    const routeMs = performance.now() - routeStarted;
    results.push({ href, feedbackMs: Number(feedbackMs.toFixed(1)), routeMs: Number(routeMs.toFixed(1)) });
  }
  console.log(JSON.stringify(results));
  await browser.close();
}

void main();
