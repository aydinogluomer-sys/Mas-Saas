import { chromium } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://localhost:3103";
const routes = [
  "/overview", "/payments", "/payments/calendar", "/payments/items", "/cashflow", "/finance",
  "/production", "/scenarios", "/insights/ask", "/insights/reports", "/insights/reminders",
  "/data/quality", "/data/imports", "/data/assumptions", "/system", "/system/features",
  "/radar", "/calendar", "/financing", "/ask", "/reports", "/reminders", "/imports",
  "/data-quality", "/assumptions", "/admin", "/phases", "/health", "/version",
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const findings = [];

for (const route of routes) {
  const response = await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const status = response?.status() ?? 0;
  const title = await page.title();
  const body = await page.locator("body").innerText().catch(() => "");
  const controls = await page.locator("button, input[type=submit], a[href]").count();
  const unlabeledButtons = await page.locator("button").evaluateAll((buttons) => buttons.filter((button) => !((button.textContent ?? "").trim() || button.getAttribute("aria-label") || button.getAttribute("title"))).length);
  findings.push({ route, status, title, controls, unlabeledButtons, serverError: /Internal Server Error|Application error|404: This page could not be found/i.test(body) });
  console.log(`AUDIT ${route} status=${status} controls=${controls} unlabeled=${unlabeledButtons}`);
}

await page.goto(`${base}/overview`, { waitUntil: "networkidle" });
await page.locator(".sidebar-command").first().click();
const commandVisible = await page.getByRole("dialog", { name: /hızlı erişim/i }).isVisible();
await page.getByLabel("Komut ara").fill("Nakit Akışı");
const commandResult = await page.getByRole("button", { name: /Nakit Akışı/i }).first().isVisible();

console.log(JSON.stringify({ pages: findings, commandPalette: { commandVisible, commandResult } }, null, 2));
await browser.close();

if (findings.some((finding) => finding.status >= 400 || finding.serverError || finding.unlabeledButtons > 0) || !commandVisible || !commandResult) process.exitCode = 1;
