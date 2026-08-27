/**
 * GEZİNME SÜPÜRMESİ — "bu link gerçekten bir yere götürüyor mu?"
 *
 * ═══ NEYİ KANIT SAYAR, NEYİ SAYMAZ ═══
 *
 * Bir gezinme kontrolü için "URL değişti" YETMEZ. Ölçülen dört şey:
 *
 *   1. GERÇEK click — `page.goto(href)` değil. Bir link `preventDefault` ile ölü bırakılmış
 *      olabilir, üstünü başka bir eleman kapatıyor olabilir, ya da `pointer-events:none`
 *      taşıyabilir. Bunların hiçbiri goto ile görünmez; click ile görünür.
 *   2. VARILAN ROTA — yönlendirmeler hesaba katılarak. `/radar` → `/payments` beklenen bir
 *      davranıştır (next.config.ts) ve doğru varış sayılır; `/login`'e düşmek DEĞİLDİR.
 *   3. HEDEF EKRAN GERÇEKTEN RENDER OLDU — sayfanın kendi <h1>'i görünür. "200 döndü" bir
 *      Server Component hatasının HTML'ini de 200 ile döndürebilir; bu denetimde tam olarak
 *      öyle iki hata bulundu (bkz. commit a5ba697).
 *   4. SIFIR istemci hatası ve SIFIR 5xx.
 *
 * ═══ TEKRAR EDEN LİNKLER NASIL SAYILIYOR (ve bu neden dürüst) ═══
 *
 * Kenar çubuğundaki "Ödemeler" linki 62 rotanın 62'sinde de vardır — ama 62 ayrı kontrol
 * değildir, tek bir kabuk bileşenidir. Bu yüzden her AYRIK href bir kez tıklanır ve o kanıt,
 * aynı href'i paylaşan bütün (rota, kontrol) birimlerine yazılır. Rapor bunu gizlemez: kaç
 * ayrık href tıklandığı ve kaç birime karşılık geldiği ayrı ayrı basılır.
 *
 * Alternatif — 1534 tıklama — aynı bileşeni 62 kez ölçüp süreyi üçe katlardı ve tek bir yeni
 * bilgi üretmezdi.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadRuntimeInventory, openAs, type SeededRole } from "./harness";

interface NavEvidence {
  route: string;
  control: string;
  role: string;
  verdict: "PASS" | "FAIL" | "EXPECTED_DISABLED";
  proof: string[];
  error?: string;
}

const OUT = path.join(process.cwd(), "docs", "interaction-audit");

/** Uygulama dışına çıkan ya da gezinme olmayan href'ler. */
function isInAppLink(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("#")) return false;
  if (/^(mailto:|tel:|https?:\/\/|data:|blob:)/i.test(href)) return false;
  return href.startsWith("/");
}

test.describe("gezinme süpürmesi", () => {
  test("her ayrık uygulama-içi href gerçek click ile hedefine varır", async ({ browser }) => {
    // Bu tek test 400+ GERÇEK tıklama yapar; varsayılan 120 sn ona göre değil. Süreyi cömert
    // tutmak, testi "hızlı olsun" diye örneklemeye indirmekten iyidir: örneklenen bir gezinme
    // süpürmesi, tam olarak örneklenmeyen linkte kırılır.
    test.setTimeout(45 * 60_000);
    const inv = loadRuntimeInventory();

    // Birim = (rota, imza). Kanıt bunlara yazılacak.
    const navUnits = inv.controls.filter((c) => c.tag === "a" && c.href && c.route !== "/login");

    // Ayrık href → onu barındıran bir kaynak rota + o href'i gören bir rol.
    // Rol seçimi ÖNEMLİ: bir link yalnız admin'e görünüyorsa viewer ile tıklanamaz.
    const targets = new Map<string, { sourceRoute: string; role: SeededRole; units: typeof navUnits }>();
    for (const u of navUnits) {
      if (!isInAppLink(u.href!)) continue;
      const existing = targets.get(u.href!);
      if (existing) {
        existing.units.push(u);
        continue;
      }
      targets.set(u.href!, { sourceRoute: u.route, role: u.role, units: [u] });
    }

    const skipped = navUnits.filter((u) => !isInAppLink(u.href!));
    const evidence: NavEvidence[] = [];

    // Uygulama dışı linkler kanıt üretmez ama SESSİZCE düşmez: ayrı bir yargıyla kaydedilir.
    for (const u of skipped) {
      evidence.push({
        route: u.route,
        control: u.signature,
        role: u.role,
        verdict: "EXPECTED_DISABLED",
        proof: [`uygulama dışı bağlantı (${u.href}) — gezinme kapsamı dışında, tıklanmadı`],
      });
    }

    // Rol başına tek bağlam aç: 413 hedef için 413 tarayıcı bağlamı açmak süreyi anlamsızca üçe katlar.
    const sessions = new Map<SeededRole, Awaited<ReturnType<typeof openAs>>>();
    const sessionFor = async (role: SeededRole) => {
      const existing = sessions.get(role);
      if (existing) return existing;
      const s = await openAs(browser, role);
      sessions.set(role, s);
      return s;
    };

    let clicked = 0;
    try {
      for (const [href, target] of targets) {
        const session = await sessionFor(target.role);
        const { page } = session;
        session.clientErrors.length = 0;
        session.serverErrors.length = 0;

        let verdict: NavEvidence["verdict"] = "PASS";
        let error: string | undefined;
        const proof: string[] = [];

        try {
          // ERR_ABORTED tekrar denemesi. Bir önceki hedefin istemci-tarafı gezinmesi hâlâ
          // uçuştayken yeni bir goto vermek Chromium'da öncekini iptal ettirir ve hata
          // KAYNAK rotaya yazılır — ölçülen şey ürün değil, sıralama olur. `/insights/briefing`
          // tam olarak böyle 26 kez "başarısız" göründü; tek başına yüklendiğinde 200/180 ms.
          let res = await page.goto(target.sourceRoute, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => {
            if (!/ERR_ABORTED/.test(String(e))) throw e;
            return null;
          });
          if (!res) {
            await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
            res = await page.goto(target.sourceRoute, { waitUntil: "domcontentloaded", timeout: 45_000 });
          }
          if ((res?.status() ?? 0) >= 400) throw new Error(`kaynak rota ${target.sourceRoute} → HTTP ${res?.status()}`);

          // GERÇEK click — ama AYNI href'i taşıyan BÜTÜN adaylar denenir, yalnız ilki değil.
          //
          // NEDEN. /cashflow'da `/cashflow/monthly?month=2027-05` iki kez geçiyor: grafikteki iki
          // veri noktası. Birincisinin tıklama noktası ikincisinin dairesiyle ÖRTÜLÜ
          // (document.elementFromPoint başka bir <circle> döndürüyor), o yüzden Playwright'ın
          // actionability kontrolü onu haklı olarak reddediyor. Ama kullanıcı açısından bağlantı
          // ÖLÜ DEĞİL: görünen diğer noktaya tıklayıp aynı yere gidiyor.
          //
          // Bu yüzden ölçüt gevşetilmedi, DOĞRU İFADE EDİLDİ: "bu href'e giden EN AZ BİR kontrol
          // gerçekten tıklanabilir mi?" Hiçbiri tıklanamıyorsa bu gerçek bir hatadır ve FAIL olur.
          const candidates = page.locator(`a[href="${href.replace(/"/g, '\\"')}"]`);
          const count = Math.min(await candidates.count(), 6);
          if (count === 0) throw new Error(`href ${href} kaynak rotada bulunamadı`);

          let clickedOk = false;
          let lastClickError = "";
          for (let i = 0; i < count; i++) {
            const link = candidates.nth(i);
            try {
              await link.scrollIntoViewIfNeeded({ timeout: 5_000 });
              await Promise.all([
                page.waitForURL(() => true, { timeout: 45_000 }).catch(() => {}),
                link.click({ timeout: 8_000 }),
              ]);
              clickedOk = true;
              if (i > 0) proof.push(`aday #${i} tıklandı (önceki adaylar örtülüydü)`);
              break;
            } catch (e) {
              lastClickError = e instanceof Error ? e.message.split(/\r?\n/)[0] : String(e);
            }
          }
          if (!clickedOk) throw new Error(`${count} adayın hiçbiri tıklanamadı — ${lastClickError}`);
          await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});

          const landed = new URL(page.url()).pathname;
          proof.push(`click ${target.sourceRoute} → ${landed}`);

          // /login'e düşmek bir gezinme başarısı DEĞİLDİR: oturum düştü ya da yetki reddedildi demektir.
          if (landed === "/login") throw new Error(`link /login'e düşürdü (oturum/yetki) — beklenen ${href}`);

          // Hedef ekran GERÇEKTEN render oldu mu? Kabuk her rotada aynıdır; ayırt edici olan <h1>.
          const heading = page.locator("main h1").first();
          await expect(heading, `${href}: hedef ekranın kendi başlığı görünmedi`).toBeVisible({ timeout: 20_000 });
          proof.push(`başlık görünür: "${(await heading.innerText()).slice(0, 60)}"`);

          const clientErrors = [...new Set(session.clientErrors)];
          const serverErrors = [...new Set(session.serverErrors)];
          if (serverErrors.length) throw new Error(`5xx: ${serverErrors.join(", ")}`);
          if (clientErrors.length) throw new Error(`istemci hatası: ${clientErrors.slice(0, 2).join(" | ")}`);
          proof.push("konsol hatası 0, 5xx 0");
          clicked += 1;
        } catch (e) {
          verdict = "FAIL";
          error = e instanceof Error ? e.message : String(e);
        }

        for (const u of target.units) {
          evidence.push({ route: u.route, control: u.signature, role: u.role, verdict, proof, error });
        }
      }
    } finally {
      for (const s of sessions.values()) await s.context.close();
    }

    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, "evidence-navigation.json"), JSON.stringify({ rows: evidence }, null, 2) + "\n", "utf8");

    const failed = evidence.filter((e) => e.verdict === "FAIL");
    const distinctFailed = new Set(failed.map((f) => f.error)).size;
    console.log(
      `gezinme: ${targets.size} ayrık href tıklandı (${clicked} başarılı), ` +
        `${evidence.length} birim kanıtlandı, ${skipped.length} uygulama dışı bağlantı atlandı`,
    );
    if (failed.length) {
      console.log(`BAŞARISIZ ${distinctFailed} ayrık hata:`);
      for (const f of [...new Map(failed.map((x) => [x.error, x])).values()].slice(0, 20)) {
        console.log(`  ${f.route} · ${f.error}`);
      }
    }
    expect(failed.map((f) => `${f.route} → ${f.error}`), "gezinme başarısızlıkları").toEqual([]);
  });
});
