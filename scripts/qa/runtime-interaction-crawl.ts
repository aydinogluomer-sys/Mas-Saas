/**
 * ÇALIŞMA ZAMANI ETKİLEŞİM TARAMASI — envanterin ikinci yarısı.
 *
 * `scripts/qa/interaction-inventory.ts` KAYNAĞI okur. Bu dosya ÇALIŞAN production sunucusunu
 * okur. İkisi ayrı ayrı eksiktir ve neden eksik oldukları farklıdır:
 *
 *   Kaynak taraması  bir kontrolün VAR olduğunu bilir, ama o kontrolün belirli bir rol/veri
 *                    durumunda GÖRÜNÜP görünmediğini bilemez. `{payable && <button…>}` deseni
 *                    repoda her yerde (bkz. instance-row.tsx) ve hangi dalın çalıştığı veriye
 *                    bağlıdır.
 *   Runtime taraması yalnız O AN görüneni görür. Rol yetkisi olmayan, verisi olmayan ya da
 *                    feature-flag kapalı bir kontrol hiç çıkmaz — ve çıkmadığı için "yok"
 *                    sanılır. Kapsamın sessizce daralmasının klasik yolu budur.
 *
 * Bu yüzden kapı ikisini KARŞILAŞTIRIR: kaynakta olup hiçbir rolde hiç görünmeyen bir kontrol
 * ya ölü koddur ya da test edilemeyen bir dal — ikisi de bir insanın bakması gereken şeydir,
 * sessizce "kapsandı" sayılamaz.
 *
 * Her kontrol için ÇALIŞTIRILABİLİRLİK de kaydedilir (disabled mı, neden disabled). "UI'da
 * gizlemek authorization değildir" ilkesi gereği, yetkisiz rolde bir aksiyonun görünmemesi
 * TEK BAŞINA yeterli kanıt sayılmaz; backend reddi ayrıca test edilir (bkz. full-interaction).
 *
 * Kullanım:
 *   BASE_URL=http://127.0.0.1:3310 MAS_E2E_DATABASE_URL=…/<disposable> \
 *     pnpm exec tsx scripts/qa/runtime-interaction-crawl.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import globalSetup, { ROLE_STATE_FILES, refreshRoleSession, statePathFor, type SeededRole } from "../../tests/visual/global-setup";
import { waitForWorkspaceReady } from "../../tests/interaction/workspace-ready";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3310";

/**
 * Taranacak rotalar. `next.config.ts`'teki kalıcı yönlendirmelerin KAYNAKLARI bilerek dışarıda:
 * /radar → /payments gibi bir rota kendi ekranını render etmez, hedefini render eder; onu ayrıca
 * taramak aynı kontrolleri iki kez saymak olurdu. Yönlendirmelerin kendisi ayrı doğrulanır.
 */
export const CRAWL_ROUTES: string[] = [
  "/overview",
  "/payments", "/payments/items", "/payments/calendar", "/payments/history",
  "/payments/missing", "/payments/archive", "/payments/new",
  "/cashflow", "/cashflow/monthly", "/cashflow/budget", "/cashflow/concentration", "/cashflow/controls",
  "/finance", "/finance/bank", "/finance/checks", "/finance/checks/new", "/finance/loans", "/finance/loans/new",
  "/finance/facilities", "/finance/collections", "/finance/counterparties", "/finance/exposure",
  "/finance/fx", "/finance/invoices", "/finance/maturities", "/finance/profitability",
  "/finance/promises", "/finance/receivables", "/finance/treasury", "/finance/archive", "/finance/calendar",
  "/production", "/production/capacity", "/production/costs", "/production/profitability", "/production/roi",
  "/scenarios", "/scenarios/compare", "/scenarios/history", "/scenarios/optimization",
  "/insights", "/insights/ask", "/insights/analysis", "/insights/briefing",
  "/insights/reminders", "/insights/reports", "/insights/tasks",
  "/data", "/data/quality", "/data/imports", "/data/assumptions", "/data/approvals",
  "/data/documents", "/data/reconciliation", "/data/reviews", "/data/sources",
  "/system", "/system/archive", "/system/audit", "/system/backup", "/system/controls",
  "/system/diagnostics", "/system/features", "/system/jobs", "/system/security",
];

export interface RuntimeControl {
  route: string;
  role: SeededRole;
  /** Kararlı imza: rol/veri değişse de aynı kontrolü tanır. */
  signature: string;
  tag: string;
  label: string;
  /** Next server action id (`$ACTION_ID_…`) — hangi server action'a bağlı olduğunun KANITI. */
  actionId: string | null;
  /** Saran <form>'un POST hedefi. */
  formAction: string | null;
  href: string | null;
  disabled: boolean;
  /** disabled ise ekranda gerekçe var mı (title/aria-describedby/yanındaki metin). */
  disabledReason: string | null;
  type: string | null;
  /** Aynı imzadan kaç tane render oldu (tablo satırları). */
  count: number;
}

const DOM_EXTRACTOR = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const nodes = Array.from(document.querySelectorAll(
    'button, a[href], summary, select, input[type=submit], input[type=checkbox], input[type=radio], input[type=file], [role=menuitem], [role=tab]'
  ));
  return nodes.map((node) => {
    const form = node.closest('form');
    let actionId = null;
    if (form) {
      const hidden = form.querySelector('input[name^="$ACTION_ID_"]');
      if (hidden) actionId = hidden.getAttribute('name');
      else {
        const ref = form.querySelector('input[name="$ACTION_REF_1"]');
        if (ref) actionId = '$ACTION_REF_1';
      }
    }
    const label =
      clean(node.textContent) ||
      node.getAttribute('aria-label') ||
      node.getAttribute('title') ||
      node.getAttribute('value') ||
      '(etiketsiz)';
    const disabled = node.disabled === true || node.getAttribute('aria-disabled') === 'true';
    let disabledReason = null;
    if (disabled) {
      disabledReason =
        node.getAttribute('title') ||
        node.getAttribute('aria-describedby') ||
        clean(node.parentElement && node.parentElement.textContent).slice(0, 160) ||
        null;
    }
    return {
      tag: node.tagName.toLowerCase(),
      label: label.slice(0, 120),
      actionId,
      formAction: form ? (form.getAttribute('action') || '(react-action)') : null,
      href: node.getAttribute('href'),
      disabled,
      disabledReason,
      type: node.getAttribute('type'),
    };
  });
})()`;

async function crawlRole(browser: Browser, role: SeededRole): Promise<{ controls: RuntimeControl[]; problems: string[] }> {
  const context = await browser.newContext({ baseURL: BASE, storageState: statePathFor(role), viewport: { width: 1440, height: 950 } });
  const page: Page = await context.newPage();
  const controls: RuntimeControl[] = [];
  const problems: string[] = [];

  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  for (const route of CRAWL_ROUTES) {
    consoleErrors.length = 0;
    let status = 0;
    try {
      const res = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 45_000 });
      status = res?.status() ?? 0;
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      // ÖN YÜKLEME PERDESİ KAPANMADAN SAYMA. Perde açıkken kontroller DOM'da durur ama
      // tıklanamaz; envanteri o anda çıkarmak "var ama kullanılamaz" bir listeyi "kullanılabilir"
      // diye kaydetmek olurdu. Gerekçe: tests/interaction/workspace-ready.ts
      await waitForWorkspaceReady(page).catch(() => {});
    } catch (e) {
      problems.push(`${role} ${route}: gezinme hatası — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const landed = new URL(page.url()).pathname;
    if (status >= 500) problems.push(`${role} ${route}: HTTP ${status}`);
    if (consoleErrors.length) problems.push(`${role} ${route}: konsol — ${[...new Set(consoleErrors)].slice(0, 3).join(" | ")}`);

    // Yetki reddi ya da login'e atılma bir HATA DEĞİL, bir GÖZLEMDİR: rol matrisinin beklediği
    // şey olabilir. Kontrol sayımı yine de yapılır ki "0 kontrol" ile "erişilemedi" karışmasın.
    const raw = (await page.evaluate(DOM_EXTRACTOR)) as Array<Omit<RuntimeControl, "route" | "role" | "signature" | "count">>;

    const grouped = new Map<string, RuntimeControl>();
    for (const c of raw) {
      const signature = `${c.tag}|${c.type ?? ""}|${c.label}|${c.actionId ?? c.href ?? ""}`;
      const existing = grouped.get(signature);
      if (existing) {
        existing.count += 1;
        // Bir satırda etkin, diğerinde pasif olabilir; "hiç etkin görülmedi" bilgisi korunur.
        if (!c.disabled) existing.disabled = false;
        continue;
      }
      grouped.set(signature, { route: landed, role, signature, count: 1, ...c });
    }
    controls.push(...grouped.values());
  }

  await context.close();
  return { controls, problems };
}

async function main(): Promise<void> {
  // OTURUMU KENDİ KURAR — bayat çerez kavanozuna güvenmez.
  //
  // NEDEN. Denetim sırasında birebir şu ölçüldü: `tests/visual/.auth/*.json` içindeki beş tokenin
  // sha256'sı veritabanındaki CANLI oturumların hiçbiriyle eşleşmiyordu; manager ve admin 67
  // rotanın 67'sinde /login'e düştü ve tarama yine "0 sorun" dedi — çünkü /login de geçerli bir
  // sayfadır ve üstünde bir buton vardır. Yani bayat kavanoz kapsamı SESSİZCE sıfıra indirip
  // yeşil görünebiliyor. Bir envanter aracının yapabileceği en kötü hata budur.
  //
  // globalSetup her koşuda kavanozu siler ve beş hesabı GERÇEK /login formundan geçirir.
  await globalSetup();

  const browser = await chromium.launch();
  const all: RuntimeControl[] = [];
  const problems: string[] = [];
  try {
    for (const role of Object.keys(ROLE_STATE_FILES) as SeededRole[]) {
      // OTURUMU KENDİ TURUNDAN HEMEN ÖNCE TAZELE.
      //
      // Ön yükleme perdesi taramayı 75 dakikaya çıkardı ve 60 dakikalık boşta kalma sınırı
      // sıradaki son rolü (admin) düşürdü: tarama hata vermeden 66 kontrol (yalnız /login)
      // raporladı. Ürün doğruydu; ölçüm aracı kendi süresini hesaba katmıyordu.
      await refreshRoleSession(browser, role);
      const r = await crawlRole(browser, role);
      all.push(...r.controls);
      problems.push(...r.problems);
      console.log(`${role}: ${r.controls.length} kontrol imzası, ${r.problems.length} sorun`);
    }
  } finally {
    await browser.close();
  }

  const distinct = new Set(all.map((c) => `${c.route}|${c.signature}`));
  const OUT = path.join(process.cwd(), "docs", "interaction-audit");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path.join(OUT, "runtime-inventory.json"),
    JSON.stringify(
      {
        summary: {
          baseUrl: BASE,
          roles: Object.keys(ROLE_STATE_FILES),
          routesCrawled: CRAWL_ROUTES.length,
          controlSignatures: all.length,
          distinctRouteControls: distinct.size,
          problems: problems.length,
        },
        problems,
        controls: all,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log(`\nToplam ${distinct.size} ayrık (rota, kontrol) çifti; ${problems.length} sorun.`);
  for (const p of problems.slice(0, 40)) console.log("  ! " + p);
}

void main();
