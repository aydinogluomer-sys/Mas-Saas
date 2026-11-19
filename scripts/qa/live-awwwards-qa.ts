import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const ITERATION = process.env.ITERATION ?? "02";
const ROOT = process.cwd();
const LOOP_SHOTS = path.join(ROOT, "awwwards-loop", "screenshots", `iteration-${ITERATION}`);
const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? "";

const ROUTES: Array<{ slug: string; path: string }> = [
  { slug: "overview", path: "/" },
  { slug: "cashflow", path: "/cashflow" },
  { slug: "cashflow-13w", path: "/cashflow/13-week" },
  { slug: "finance", path: "/finance" },
  { slug: "finance-ledger", path: "/finance/ledger" },
  { slug: "finance-profitability", path: "/finance/profitability" },
  { slug: "production", path: "/production" },
  { slug: "scenarios", path: "/scenarios" },
  { slug: "insights", path: "/insights" },
  { slug: "data-imports", path: "/data/imports" },
  { slug: "data-integrations", path: "/data/integrations" },
  { slug: "system-features", path: "/system/features" },
  { slug: "system-security", path: "/system/security" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
] as const;

interface RouteCheck {
  route: string;
  viewport: string;
  status: number;
  overflowPx: number;
  darkSurfaceCount: number;
  consoleErrors: string[];
  pageErrors: string[];
  screenshotPath: string;
}

async function main(): Promise<void> {
  mkdirSync(LOOP_SHOTS, { recursive: true });
  mkdirSync(path.join(ROOT, "awwwards-loop", "reports"), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const checks: RouteCheck[] = [];
  let chartProof: Record<string, unknown> = {};

  try {
    const bootstrapCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const bootstrapPage = await bootstrapCtx.newPage();
    await bootstrapPage.goto(`${BASE_URL}/`, { waitUntil: "networkidle", timeout: 45_000 });
    if (bootstrapPage.url().includes("/login")) {
      await bootstrapPage.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
      await bootstrapPage.waitForLoadState("networkidle");
    }
    const storageState = await bootstrapCtx.storageState();
    await bootstrapCtx.close();

    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        storageState,
      });
      const page = await ctx.newPage();

      const routesForVp =
        vp.name === "desktop"
          ? ROUTES
          : ROUTES.filter((r) =>
              ["overview", "cashflow", "cashflow-13w", "production", "data-imports", "finance-ledger", "scenarios"].includes(
                r.slug,
              ),
            );

      for (const r of routesForVp) {
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const onConsole = (msg: import("@playwright/test").ConsoleMessage) => {
          if (msg.type() === "error") consoleErrors.push(msg.text());
        };
        const onPageError = (err: Error) => {
          pageErrors.push(err.message);
        };
        page.on("console", onConsole);
        page.on("pageerror", onPageError);

        const resp = await page.goto(`${BASE_URL}${r.path}`, { waitUntil: "networkidle", timeout: 45_000 });
        await page.waitForTimeout(250);

        const metrics = await page.evaluate(() => {
          const doc = document.documentElement;
          const overflowPx = Math.max(0, doc.scrollWidth - doc.clientWidth);
          const cards = Array.from(document.querySelectorAll("main section, main article, main form, main .panel"));
          let darkSurfaceCount = 0;
          for (const el of cards) {
            const bg = getComputedStyle(el).backgroundColor;
            const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
            if (m) {
              const red = Number(m[1]);
              const green = Number(m[2]);
              const blue = Number(m[3]);
              const alpha = m[4] === undefined ? 1 : Number(m[4]);
              if (alpha > 0.8 && red < 35 && green < 35 && blue < 45 && el.clientWidth > 160 && el.clientHeight > 60) {
                darkSurfaceCount++;
              }
            }
          }
          return { overflowPx, darkSurfaceCount };
        });

        const fileName = `awwwards_v2_${vp.name}_${r.slug}.png`;
        const shotPath = path.join(LOOP_SHOTS, fileName);
        await page.screenshot({ path: shotPath, fullPage: false });

        if (
          ARTIFACT_DIR &&
          (vp.name === "desktop" ||
            (vp.name === "tablet" && (r.slug === "overview" || r.slug === "finance-ledger")) ||
            (vp.name === "mobile" && (r.slug === "overview" || r.slug === "production")))
        ) {
          copyFileSync(shotPath, path.join(ARTIFACT_DIR, fileName));
        }

        checks.push({
          route: r.path,
          viewport: `${vp.name} (${vp.width}x${vp.height})`,
          status: resp?.status() ?? 0,
          overflowPx: metrics.overflowPx,
          darkSurfaceCount: metrics.darkSurfaceCount,
          consoleErrors,
          pageErrors,
          screenshotPath: shotPath,
        });

        page.off("console", onConsole);
        page.off("pageerror", onPageError);
      }

      await ctx.close();
    }

    // Programmatic & Visual Chart Vertical Y-Axis Rescaling Proof on `/`
    const chartCtx = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      storageState,
    });
    const chartPage = await chartCtx.newPage();
    await chartPage.goto(`${BASE_URL}/`, { waitUntil: "networkidle", timeout: 45_000 });
    await chartPage.waitForTimeout(250);

    // Scroll SVG chart right into center of viewport so screenshots capture Y-axis ticks & bars clearly
    await chartPage.evaluate(() => {
      const svg = document.querySelector("main svg[role='img']");
      svg?.scrollIntoView({ block: "center" });
    });
    await chartPage.waitForTimeout(150);

    const captureChartState = async () =>
      chartPage.evaluate(() => {
        const svg = document.querySelector("main svg[role='img']");
        if (!svg) return null;
        const yTicks = Array.from(svg.querySelectorAll("text[text-anchor='end']")).map((t) =>
          (t.textContent ?? "").trim(),
        );
        const pathDs = Array.from(svg.querySelectorAll("path"))
          .map((p) => p.getAttribute("d") ?? "")
          .filter((d) => d.length > 10)
          .slice(0, 2);
        const rectHeights = Array.from(svg.querySelectorAll("rect"))
          .map((r) => ({ y: r.getAttribute("y"), h: r.getAttribute("height") }))
          .filter((r) => r.y !== null && Number(r.h) > 0 && Number(r.h) < 400)
          .slice(0, 6);
        return { yTicks, pathDs, rectHeights };
      });

    const clickPeriod = async (label: string) => {
      await chartPage.evaluate((lbl) => {
        const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("main button")).find(
          (b) => b.textContent?.trim() === lbl,
        );
        btn?.click();
      }, label);
      await chartPage.waitForTimeout(180);
    };

    await clickPeriod("3A");
    const state3m = await captureChartState();
    const shot3m = path.join(LOOP_SHOTS, "awwwards_v2_chart_3m_window_scale.png");
    await chartPage.screenshot({ path: shot3m, fullPage: false });
    if (ARTIFACT_DIR) copyFileSync(shot3m, path.join(ARTIFACT_DIR, "awwwards_v2_chart_3m_window_scale.png"));

    await clickPeriod("Tümü");
    const stateAll = await captureChartState();
    const shotAll = path.join(LOOP_SHOTS, "awwwards_v2_chart_all_window_scale.png");
    await chartPage.screenshot({ path: shotAll, fullPage: false });
    if (ARTIFACT_DIR) copyFileSync(shotAll, path.join(ARTIFACT_DIR, "awwwards_v2_chart_all_window_scale.png"));

    await clickPeriod("3A");
    await chartPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("main button")).find(
        (b) => b.textContent?.includes("Pencere Ölçeği") || b.textContent?.includes("Tüm Ufuk Ölçeği"),
      );
      btn?.click();
    });
    await chartPage.waitForTimeout(180);
    const state3mFullHorizon = await captureChartState();

    chartProof = {
      route: "/",
      state3m,
      stateAll,
      state3mFullHorizon,
      yTicksChangedBetween3mAndAll: JSON.stringify(state3m?.yTicks) !== JSON.stringify(stateAll?.yTicks),
      geometryChangedBetweenWindowAndFullScale:
        JSON.stringify(state3m?.yTicks) !== JSON.stringify(state3mFullHorizon?.yTicks) ||
        JSON.stringify(state3m?.pathDs) !== JSON.stringify(state3mFullHorizon?.pathDs) ||
        JSON.stringify(state3m?.rectHeights) !== JSON.stringify(state3mFullHorizon?.rectHeights),
    };

    await chartCtx.close();

    const summary = {
      iteration: ITERATION,
      totalChecks: checks.length,
      http500Count: checks.filter((c) => c.status >= 500 || c.status === 0).length,
      overflowFailures: checks.filter((c) => c.overflowPx > 1),
      darkSurfaceFailures: checks.filter((c) => c.darkSurfaceCount > 0),
      consoleErrorCount: checks.reduce((acc, c) => acc + c.consoleErrors.length, 0),
      pageErrorCount: checks.reduce((acc, c) => acc + c.pageErrors.length, 0),
      chartProof,
      checks,
    };

    const outJson = path.join(ROOT, "awwwards-loop", "reports", `iteration-${ITERATION}-evidence.json`);
    writeFileSync(outJson, JSON.stringify(summary, null, 2) + "\n", "utf8");
    console.log(`\n=== LIVE AWWWARDS QA SUMMARY (ITERATION ${ITERATION}) ===`);
    console.log(`Total Route×Viewport Checks : ${summary.totalChecks}`);
    console.log(`HTTP >= 500 Errors          : ${summary.http500Count}`);
    console.log(`Horizontal Overflow (>1px)  : ${summary.overflowFailures.length}`);
    console.log(`Dark Surface Remnants       : ${summary.darkSurfaceFailures.length}`);
    console.log(`Console Errors              : ${summary.consoleErrorCount}`);
    console.log(`Uncaught Page Errors        : ${summary.pageErrorCount}`);
    console.log(`Chart 3A Y-Ticks            : ${JSON.stringify(state3m?.yTicks)}`);
    console.log(`Chart Tümü Y-Ticks          : ${JSON.stringify(stateAll?.yTicks)}`);
    console.log(`Chart 3A Full-Horizon Ticks : ${JSON.stringify(state3mFullHorizon?.yTicks)}`);

    if (
      summary.http500Count > 0 ||
      summary.overflowFailures.length > 0 ||
      summary.darkSurfaceFailures.length > 0 ||
      summary.consoleErrorCount > 0 ||
      summary.pageErrorCount > 0
    ) {
      console.error(
        "HARD GATE FAILED:",
        JSON.stringify(
          {
            overflow: summary.overflowFailures,
            dark: summary.darkSurfaceFailures,
            consoleErrors: checks.filter((c) => c.consoleErrors.length > 0),
            pageErrors: checks.filter((c) => c.pageErrors.length > 0),
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

void main();
