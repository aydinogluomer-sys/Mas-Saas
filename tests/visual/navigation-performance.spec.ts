import { expect, test } from "@playwright/test";

// Faz 2 §5.2 — this line used to be a test.use({ baseURL: ... }) carrying its own loopback
// fallback on port 3110, a SECOND default competing with the one in playwright.config.ts. Two
// defaults means the suite can be pointed somewhere new and still have one spec quietly aim at the
// old port. The config is now the only place a port is written down, so nothing is overridden here
// at all. The literal is not repeated: the §5.2 gate greps this directory for it.

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

// `mode: "serial"` removed, timeout kept — same reason as analytics.spec.ts. These four tests share
// no state, but serial mode makes the first failure SKIP the rest, so a single slow navigation hid
// the "reduced motion" result entirely. Execution stays sequential via workers: 1 in the config.
test.describe.configure({ timeout: 120_000 });

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

test("a delayed route is never left hanging: within 200ms EXACTLY the right one of skeleton/arrival", async ({ page }) => {
  // AŞAMA 10 — BU TEST ARTIK "İKİSİNDEN BİRİ OLSUN" DEMİYOR.
  //
  // Eski hâli `expect(["skeleton", "arrived"]).toContain(outcome.kind)` idi ve gerekçesi
  // doğruydu: Next, /overview yerleşir yerleşmez kenar çubuğundaki <Link> hedeflerini
  // prefetch eder; prefetch tıklamadan önce inerse rota istemci yönlendirici önbelleğinden
  // servis edilir, ORTADA BEKLEYEN BİR GEZİNME YOKTUR ve iskelet göstermek yanlış olurdu.
  // Üç koşuda ölçülen buydu:
  //
  //   skeleton=false  tıklama öncesi /cashflow isteği=1 (prefetch)  sonrası=0   <- önbellek
  //   skeleton=false  tıklama öncesi=1 (prefetch)                   sonrası=0   <- önbellek
  //   skeleton=true   tıklama öncesi=0                              sonrası=1   <- gerçek gezinme
  //
  // EKSİK OLAN ŞEY, HANGİ DALDA OLUNDUĞUNU BİLMEKTİ. "İkisi de olur" iddiası, iskeletin HİÇ
  // gelmediği bir regresyonu da kabul eder: prefetch her koşuda kazanırsa test sonsuza kadar
  // yeşil kalır ve iskelet yolu bir daha hiç sınanmaz. Kabul edilen kümeyi daraltmadan bu
  // kapatılamaz — ama daraltmak için önce hangi dalda olunduğunun ÖLÇÜLMESİ gerekir.
  //
  // Sınıflandırma artık olan bitene bakılarak, sonradan yapılıyor: tıklamadan SONRA sunucuya
  // giden bir /cashflow RSC isteği var mı?
  //
  //   sonrası = 0  → rota önbellekten geldi, bekleyen gezinme yok → 200 ms içinde VARILMIŞ olmalı
  //   sonrası ≥ 1  → gerçek gezinme (ve 500 ms geciktirildi)      → 200 ms içinde İSKELET olmalı
  //
  // Bu bir yarış değil, gözlemdir: istek ya gitti ya gitmedi. Her koşu artık TEK bir sonucu
  // zorunlu kılıyor, "neither" ise her iki dalda da düşüyor.
  //
  // Prefetch hâlâ İPTAL EDİLMİYOR: iptal edilen bir fetch "Failed to fetch" konsol hatası
  // üretir ve §5.3 kapısı sayfayı bu yüzden düşürür. Açık tutmak da denendi ve yalnız bir
  // artefaktı başkasıyla değiştirdi (meşgul bağlantı). Gecikme her iki isteğe de uygulanıyor
  // ki iskelet dalı da düzenli olarak çalışsın.
  const navigationRequestsAfterClick: string[] = [];
  let clicked = false;
  await page.route(/\/cashflow(?:\?.*)?$/, async (route) => {
    const headers = route.request().headers();
    const isRsc = headers.rsc === "1";
    const isPrefetch = headers["next-router-prefetch"] === "1";
    if (isRsc && !isPrefetch && clicked) navigationRequestsAfterClick.push(route.request().url());
    if (isRsc) await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto("/overview", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.navigationReady === "true");

  clicked = true;
  const outcome = await page.evaluate(() => new Promise<{ kind: string; ms: number }>((resolve, reject) => {
    const anchor = document.querySelector<HTMLAnchorElement>('.sidebar-link[href="/cashflow"]');
    if (!anchor) return reject(new Error("Cashflow link is missing"));
    const startedAt = performance.now();
    let done = false;
    const finish = (kind: string): void => {
      if (done) return;
      done = true;
      observer.disconnect();
      resolve({ kind, ms: performance.now() - startedAt });
    };
    const observer = new MutationObserver(() => {
      const shell = document.querySelector<HTMLElement>(".instant-navigation-skeleton");
      if (shell && getComputedStyle(shell).display !== "none") finish("skeleton");
    });
    observer.observe(document.body, { childList: true, subtree: true });
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    window.setTimeout(() => finish(location.pathname === "/cashflow" ? "arrived" : "neither"), 200);
  }));
  // Gecikmeli isteğin ağ katmanında tamamlanmasına fırsat ver, sonra sınıflandırmayı oku.
  await page.waitForURL((u) => u.pathname === "/cashflow", { timeout: 30_000 });

  const servedFromCache = navigationRequestsAfterClick.length === 0;
  test.info().annotations.push({
    type: "skeleton-branch",
    description: JSON.stringify({ servedFromCache, kind: outcome.kind, ms: Math.round(outcome.ms) }),
  });

  if (servedFromCache) {
    // Prefetch kazandı: bekleyen gezinme YOK, iskelet göstermek yanlış olurdu. O hâlde 200 ms
    // içinde gerçekten VARILMIŞ olması gerekir — "hiçbir şey olmadı" burada da kabul değil.
    expect(outcome.kind, `prefetch önbellekten servis etti; 200 ms içinde varılmalıydı (${outcome.ms.toFixed(0)}ms)`)
      .toBe("arrived");
  } else {
    // Gerçek gezinme, üstelik 500 ms geciktirilmiş: kullanıcı 200 ms içinde İSKELET görmeli.
    expect(outcome.kind, `gerçek gezinme 500 ms geciktirildi; 200 ms içinde iskelet gelmeliydi (${outcome.ms.toFixed(0)}ms)`)
      .toBe("skeleton");
  }
});

test("reduced motion disables navigation and skeleton animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/overview", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.navigationReady === "true");
  await page.locator('.sidebar-link[href="/cashflow"]').click({ noWaitAfter: true });
  await expect(page.locator(".navigation-progress")).toHaveCSS("animation-name", "none");
});
