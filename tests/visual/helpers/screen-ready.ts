// Faz 2 §5.3 — the assertions every snapshot test must pass BEFORE it is allowed to compare pixels.
//
// WHY THE ORDER IS THE POINT, NOT THE ASSERTIONS THEMSELVES.
//
// The legacy specs were `goto -> screenshot`. That sequence cannot distinguish the two failures
// people actually care about, because it produces the SAME red either way:
//
//   * the product broke     (a page now renders wrong)
//   * the harness broke     (auth died and the "page" is really /login, or the fixture changed)
//
// A screenshot of the login page is a perfectly stable PNG. Baseline it once by accident and the
// suite goes green while testing nothing. That is not hypothetical here: the whole reason this
// phase exists is that the legacy suite was authenticating through a bypass that redirect-looped.
//
// So the contract is: auth -> route -> heading -> content -> no error -> only then screenshot.
// Everything before the screenshot is SEMANTIC and fails with a sentence naming what went wrong.
// If those pass and only the pixels differ, the difference is by definition a rendering/baseline
// delta and not a broken screen — which is exactly the automatic separation Faz 2 asks for.

import { expect, type Page } from "@playwright/test";

/** The unauthorized shell rendered by src/lib/authz/route-guard.tsx. */
const DENIED = "[data-testid='route-access-denied']";

/** Stock Next shells. This app ships no custom error.tsx, so a failure renders one of these. */
const ERROR_SHELL_MARKERS = ["Application error", "Internal Server Error", "This page could not be found"];

/**
 * Turn on visual-regression mode: `data-vr="1"` on <html>, which globals.css uses to hide every
 * [data-volatile] node (timestamps, "bugün" badges) so screenshots are comparable across days.
 *
 * THIS EXISTS BECAUSE THE ONE-LINER IT REPLACES NEVER WORKED. Three specs each ran
 *
 *     page.addInitScript(() => document.documentElement.setAttribute("data-vr", "1"))
 *
 * and addInitScript executes before the document has a documentElement, so every page load threw
 * "Cannot read properties of null (reading 'setAttribute')" and the attribute was never applied.
 * Measured on a running server: pageerror on every route, `document.documentElement.dataset.vr`
 * === null afterwards, and [data-volatile] nodes VISIBLE.
 *
 * The consequence is worse than a stray console error. The suite's entire determinism mechanism
 * was inert, so every committed baseline contains volatile content and drifts on its own schedule.
 * Nobody noticed because nothing in the old specs watched for page errors — which is precisely the
 * gap §5.3 closes.
 */
export async function enableVisualRegressionMode(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const set = (): void => {
      document.documentElement?.setAttribute("data-vr", "1");
    };
    set(); // <html> may already exist depending on when this runs
    document.addEventListener("readystatechange", set);
    document.addEventListener("DOMContentLoaded", set);
  });
}

export interface ScreenWatch {
  consoleErrors: string[];
  pageErrors: string[];
  serverErrors: string[];
}

/**
 * Attach error collectors. MUST be called before the navigation you intend to judge — listeners
 * added afterwards miss everything the page did while loading, which is when most of it happens.
 */
export function watchScreen(page: Page): ScreenWatch {
  const watch: ScreenWatch = { consoleErrors: [], pageErrors: [], serverErrors: [] };
  page.on("console", (m) => {
    if (m.type() === "error") watch.consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => watch.pageErrors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 500) watch.serverErrors.push(`${r.status()} ${r.url()}`);
  });
  return watch;
}

export interface ReadyOptions {
  /** Pathname the browser must have ended on. Redirects are legitimate; silence about them is not. */
  expected: string;
  watch: ScreenWatch;
  /** Set false for screens that are genuinely chrome-only (none today; kept explicit). */
  requireContent?: boolean;
}

/**
 * Assert the CURRENT page is a real, authenticated, error-free screen.
 *
 * Split from navigation so it can also be used after a click-driven transition, which is how
 * navigation-visual and navigation-performance reach their screens.
 */
export async function assertScreenReady(page: Page, options: ReadyOptions): Promise<void> {
  const { expected, watch, requireContent = true } = options;

  // ── auth ───────────────────────────────────────────────────────────────────────────────
  // First, because every later assertion is meaningless if this one is false. A login page has
  // a heading, has content, and screenshots beautifully.
  const finalPath = new URL(page.url()).pathname.replace(/\/$/, "") || "/";
  expect(finalPath, `${expected}: /login'e düştü — oturum kurulamamış (QA bypass döngüsü mü?)`)
    .not.toBe("/login");
  expect(await page.locator(DENIED).count(), `${expected}: yetkisiz kabuğu render edildi`).toBe(0);

  // ── route ──────────────────────────────────────────────────────────────────────────────
  expect(finalPath, `${expected}: beklenmeyen son URL`).toBe(expected);

  // ── heading ────────────────────────────────────────────────────────────────────────────
  const h1 = page.locator("h1").first();
  await expect(h1, `${expected}: ana başlık görünmüyor`).toBeVisible({ timeout: 20_000 });
  expect((await h1.innerText()).trim().length, `${expected}: ana başlık boş`).toBeGreaterThan(0);

  // ── content ────────────────────────────────────────────────────────────────────────────
  if (requireContent) {
    const main = page.locator("main");
    const mainText = (await main.innerText()).trim();
    expect(mainText.length, `${expected}: <main> neredeyse boş (${mainText.length} karakter)`)
      .toBeGreaterThan(80);

    // Data surface OR an explicit empty state — never silence. A migrated-but-dataless database
    // renders a deliberate "Henüz veri yok" panel, which is correct; a blank shell is not.
    const surfaces = await page.locator(".tabular-nums, table, .command-surface, .border-dashed").count();
    expect(surfaces, `${expected}: ne veri/KPI yüzeyi ne açık "veri yok" durumu — sessiz boş kabuk`)
      .toBeGreaterThan(0);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText, `${expected}: ekranda NaN`).not.toMatch(/\bNaN\b/);
    expect(bodyText, `${expected}: ekranda undefined`).not.toMatch(/\bundefined\b/);
    expect(bodyText, `${expected}: ekranda Infinity`).not.toMatch(/\bInfinity\b/);
    for (const marker of ERROR_SHELL_MARKERS) {
      expect(bodyText, `${expected}: genel hata kabuğu ("${marker}")`).not.toContain(marker);
    }
  }

  // ── no error ───────────────────────────────────────────────────────────────────────────
  expect(watch.pageErrors, `${expected}: pageerror`).toEqual([]);
  expect(watch.serverErrors, `${expected}: 5xx alt istek`).toEqual([]);
  expect(watch.consoleErrors, `${expected}: console.error`).toEqual([]);
}

/**
 * Navigate and assert readiness in one step — the common case.
 *
 * Returns the watch so a caller can make further assertions against errors that happen later
 * (during an interaction, say) without re-attaching listeners.
 */
export async function openScreen(page: Page, href: string, expected: string, requireContent = true): Promise<ScreenWatch> {
  const watch = watchScreen(page);
  const response = await page.goto(href, { waitUntil: "domcontentloaded" });
  expect(response, `${href}: navigasyon yanıtı yok`).not.toBeNull();
  expect(response!.status(), `${href}: HTTP durumu`).toBe(200);
  await assertScreenReady(page, { expected, watch, requireContent });
  return watch;
}
