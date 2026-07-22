import { chromium } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3103";
const routes = [
  "/overview", "/payments", "/payments/calendar", "/payments/items",
  "/cashflow", "/finance", "/production", "/scenarios",
  "/insights/ask", "/insights/reports", "/insights/reminders",
  "/data/quality", "/data/imports", "/data/assumptions",
  "/system", "/system/features",
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const inventory = [];

for (const route of routes) {
  const errors = [];
  const onConsole = (message) => {
    if (message.type() === "error") errors.push(message.text());
  };
  const onPageError = (error) => errors.push(error.message);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  const response = await page.goto(`${base}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
  const buttons = await page.locator("button").evaluateAll((nodes) => nodes.map((node) => {
    const form = node.closest("form");
    return {
      label: (node.textContent ?? "").replace(/\s+/g, " ").trim() || node.getAttribute("aria-label") || node.getAttribute("title") || "(etiketsiz)",
      disabled: node.disabled,
      type: node.getAttribute("type") ?? "submit",
      formAction: node.getAttribute("formaction"),
      formMethod: form?.getAttribute("method") ?? null,
      hasForm: Boolean(form),
      className: node.className,
    };
  }));
  inventory.push({ route, status: response?.status() ?? 0, errors: [...new Set(errors)], buttons });
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
}

console.log(JSON.stringify(inventory, null, 2));
await browser.close();
