import { chromium } from "@playwright/test";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3001";
const routes = process.argv.slice(2);
const targets = routes.length > 0 ? routes : ["/", "/admin", "/ask", "/data-quality", "/cashflow", "/scenarios", "/production"];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

for (const route of targets) {
  await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("main", { timeout: 60000 });
  await page.waitForFunction(
    () => (document.querySelector("main")?.textContent ?? "").trim().length > 20,
    { timeout: 60000 },
  );

  const result = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const labelOf = (el) => {
      const explicit = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "";
      return (
        el.getAttribute("aria-label") ||
        explicit ||
        el.closest("label")?.textContent ||
        el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("value") ||
        el.textContent ||
        ""
      );
    };
    const interactive = [...document.querySelectorAll("a,button,input,textarea,select,summary,[role='button']")]
      .filter(visible);
    const emptyNames = interactive
      .filter((el) => labelOf(el).trim().length === 0)
      .map((el) => el.tagName.toLowerCase());
    const focusTarget = interactive.find((el) => el instanceof HTMLAnchorElement || el instanceof HTMLButtonElement);
    focusTarget?.focus();
    const focusStyle = focusTarget ? getComputedStyle(focusTarget) : null;
    return {
      interactive: interactive.length,
      emptyNames,
      focusOutlineWidth: focusStyle?.outlineWidth ?? null,
      focusOutlineStyle: focusStyle?.outlineStyle ?? null,
    };
  });

  console.log(`${route} interactive=${result.interactive} emptyNames=${result.emptyNames.length} focus=${result.focusOutlineStyle}/${result.focusOutlineWidth}`);
  if (result.emptyNames.length > 0) {
    throw new Error(`${route} has empty interactive names: ${result.emptyNames.join(", ")}`);
  }
  if (!result.focusOutlineWidth || result.focusOutlineWidth === "0px" || result.focusOutlineStyle === "none") {
    throw new Error(`${route} does not expose a visible focus outline`);
  }
}

await browser.close();
