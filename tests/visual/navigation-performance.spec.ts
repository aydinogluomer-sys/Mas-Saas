import { expect, test } from "@playwright/test";

test.use({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3110" });

const PRIMARY_ROUTES = [
  { href: "/payments", destination: "/payments" },
  { href: "/cashflow", destination: "/cashflow" },
  { href: "/finance", destination: "/finance" },
  { href: "/production", destination: "/production" },
  { href: "/scenarios", destination: "/scenarios" },
  { href: "/insights/ask", destination: "/insights/ask" },
  { href: "/data/quality", destination: "/data/quality" },
  { href: "/system", destination: "/system" },
  { href: "/overview", destination: "/overview" },
] as const;

test.describe.configure({ mode: "serial", timeout: 120_000 });

test("primary navigation acknowledges every click within 50ms", async ({ page }) => {
  await page.goto("/overview", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.navigationReady === "true");
  const results: Array<{ href: string; feedbackMs: number }> = [];

  for (const route of PRIMARY_ROUTES) {
    const { href, destination } = route;
    if (new URL(page.url()).pathname === destination) await page.goto(href === "/overview" ? "/payments" : "/overview", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.documentElement.dataset.navigationReady === "true");
    const feedbackMs = await page.evaluate((targetHref) => {
      const anchor = document.querySelector<HTMLAnchorElement>(`.sidebar-link[href="${targetHref}"]`);
      if (!anchor) throw new Error(`Missing navigation link ${targetHref}`);
      const startedAt = performance.now();
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      if (anchor.getAttribute("aria-current") !== "page" || !document.querySelector(".navigation-pending")) throw new Error(`No immediate feedback for ${targetHref}`);
      return performance.now() - startedAt;
    }, href);
    results.push({ href, feedbackMs });
    expect(feedbackMs, `${href} click feedback`).toBeLessThanOrEqual(50);
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000, message: `${href} should reach ${destination}` }).toBe(destination);
  }

  test.info().annotations.push({ type: "navigation-timings", description: JSON.stringify(results) });
});

test("module tabs acknowledge click and preserve keyboard focus behavior", async ({ page }) => {
  await page.goto("/production", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.navigationReady === "true");
  const target = page.locator('.module-tabs a[href="/production/capacity"]');
  await target.focus();
  await expect(target).toBeFocused();
  const feedbackMs = await target.evaluate((anchor) => new Promise<number>((resolve, reject) => {
    const startedAt = performance.now();
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    const inspect = () => {
      const current = document.querySelector<HTMLAnchorElement>('.module-tabs a[href="/production/capacity"]');
      if (current?.classList.contains("is-pending") || current?.classList.contains("is-active")) return resolve(performance.now() - startedAt);
      if (performance.now() - startedAt > 50) return reject(new Error("Module tab did not become active within 50ms"));
      window.setTimeout(inspect, 0);
    };
    window.setTimeout(inspect, 0);
  }));
  expect(feedbackMs).toBeLessThanOrEqual(50);
  await page.waitForURL("**/production/capacity");
});

test("a delayed route reveals its skeleton within 200ms", async ({ page }) => {
  await page.route(/\/cashflow(?:\?.*)?$/, async (route) => {
    if (route.request().headers().rsc === "1") await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto("/overview", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.navigationReady === "true");
  const shellMs = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const anchor = document.querySelector<HTMLAnchorElement>('.sidebar-link[href="/cashflow"]');
    if (!anchor) return reject(new Error("Cashflow link is missing"));
    const startedAt = performance.now();
    const observer = new MutationObserver(() => {
      const shell = document.querySelector<HTMLElement>(".instant-navigation-skeleton");
      if (shell && getComputedStyle(shell).display !== "none") {
        observer.disconnect();
        resolve(performance.now() - startedAt);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    window.setTimeout(() => { observer.disconnect(); reject(new Error("Route skeleton did not appear within 200ms")); }, 200);
  }));
  expect(shellMs).toBeLessThanOrEqual(200);
});

test("reduced motion disables navigation and skeleton animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/overview", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.navigationReady === "true");
  await page.locator('.sidebar-link[href="/cashflow"]').click({ noWaitAfter: true });
  await expect(page.locator(".navigation-progress")).toHaveCSS("animation-name", "none");
});
