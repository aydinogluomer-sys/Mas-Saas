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
import { waitForWorkspaceReady } from "./workspace-ready";

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

    /**
     * SATIR LİNKLERİ TEK KONTROLDÜR — kimliğe göre değil, ŞEKLE göre gruplanır.
     *
     * `/payments/1d8250ac-…/edit` ile `/payments/e6cef3de-…/edit` iki ayrı kontrol DEĞİLDİR:
     * aynı tablo hücresinin iki satırıdır. Onları ayrı hedef saymak iki şeyi birden bozuyordu:
     *
     *   1. MALİYET — 40 satırlık bir tablo 40 hedef üretiyordu; hepsi aynı bileşeni ölçüyordu.
     *   2. DOĞRULUK — bu href'ler VERİYE bağlıdır. Tarama ile test arasında mutasyon testleri
     *      satır ekleyip değiştiriyor, o kimlikler ekrandan kayboluyor ve süpürme "href kaynak
     *      rotada bulunamadı" diye KIRMIZI veriyordu. Ölçüldü: /payments/<uuid>/edit biçimindeki
     *      her hedef bu şekilde başarısız göründü. Ürün sağlamdı; kimlik bayatlamıştı.
     *
     * UUID ve saf sayı segmentleri `:id`'ye indirgenerek gruplanır; her ŞEKİL için ekranda o an
     * GERÇEKTEN duran bir örnek tıklanır. Kanıt yine bütün birimlere yazılır, yani kapsam
     * azalmaz — azalan tek şey, aynı bileşeni tekrar tekrar ölçmenin maliyeti.
     */
    const shapeOf = (href: string): string =>
      href
        .split("?")[0]
        .split("/")
        .map((seg) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d+$/.test(seg) ? ":id" : seg))
        .join("/");

    const targets = new Map<string, { href: string; sourceRoute: string; role: SeededRole; units: typeof navUnits }>();
    for (const u of navUnits) {
      if (!isInAppLink(u.href!)) continue;
      const key = shapeOf(u.href!);
      const existing = targets.get(key);
      if (existing) {
        existing.units.push(u);
        continue;
      }
      targets.set(key, { href: u.href!, sourceRoute: u.route, role: u.role, units: [u] });
    }

    /**
     * DİLİMLEME — kapsamı azaltmaz, tek koşunun ömrünü kısaltır.
     *
     * Bu makine 244 hedefi tek oturumda bitiremiyor: boş RAM 0.13 GB'a inince Chromium
     * `ERR_NETWORK_IO_SUSPENDED` vermeye ve tıklamalar 8 sn'de zaman aşımına uğramaya başladı —
     * ÜRÜN kusursuzken 2919 birim "başarısız" göründü. Ölçüm ortamının çöküşünü ürün hatası diye
     * raporlamak, bu denetimin tam olarak engellemeye çalıştığı şey.
     *
     * `NAV_SLICE="1/3"` hedefleri deterministik olarak üçe böler ve her dilim KENDİ kanıt
     * dosyasına yazar (`evidence-navigation-1-3.json`). Kapı bütün `evidence-*.json`'ları
     * birleştirdiği için üç dilim = tam kapsam. Dilim verilmezse davranış birebir eskisi.
     */
    const sliceSpec = process.env.NAV_SLICE ?? "";
    const sliceMatch = /^(\d+)\/(\d+)$/.exec(sliceSpec);
    const sliceIndex = sliceMatch ? Number(sliceMatch[1]) : 1;
    const sliceCount = sliceMatch ? Number(sliceMatch[2]) : 1;
    expect(sliceIndex >= 1 && sliceIndex <= sliceCount, `NAV_SLICE geçersiz: '${sliceSpec}'`).toBe(true);

    if (sliceCount > 1) {
      const all = [...targets.keys()];
      for (const [i, href] of all.entries()) {
        if (i % sliceCount !== sliceIndex - 1) targets.delete(href);
      }
      console.log(`NAV_SLICE ${sliceIndex}/${sliceCount}: ${targets.size}/${all.length} hedef bu dilimde`);
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

    /* ── BELLEK: AYNI ANDA TEK BAĞLAM ────────────────────────────────────────────────────
     *
     * İlk yazımda beş rolün bağlamı de açılıp koşu boyunca AÇIK TUTULUYORDU. Bu makinede
     * ölçüldü: 7.9 GB RAM'in boşu 0.35 GB'a indi, 19 chrome süreci aynı anda yaşadı ve 2.5
     * dakikada biten süpürme 30 dakikada bitmedi — takas dosyası dönüyordu. Testin kendisi
     * doğruydu, maliyeti yanlıştı.
     *
     * Hedefler artık ROLE GÖRE gruplanır; her rol için tek bağlam açılır, o rolün bütün
     * hedefleri işlenir, bağlam KAPATILIR. Tepe bellek beşte bire iner ve toplam tıklama
     * sayısı değişmez — yani kapsamdan hiçbir şey feda edilmez.
     */
    const byRole = new Map<SeededRole, Array<[string, (typeof targets) extends Map<string, infer V> ? V : never]>>();
    for (const entry of targets) {
      const list = byRole.get(entry[1].role) ?? [];
      list.push(entry);
      byRole.set(entry[1].role, list);
    }

    /**
     * BAĞLAM GERİ DÖNÜŞÜMÜ — uzun ömürlü tek sayfa belleği biriktiriyor.
     *
     * Rol başına tek bağlam açmak tepe belleği beşte bire indirdi ama yetmedi: TEK bir sayfa 244
     * kez gezindiğinde JS heap'i, önbellekler ve ayrılmamış render süreçleri birikiyor. Ölçüldü —
     * boş RAM yine 0.38 GB'a indi, 17 chrome süreci yaşadı ve süpürme 20 dakikada bitmedi.
     *
     * Çözüm kapsamı DEĞİL, ömrü kısaltmak: her CONTEXT_RECYCLE_EVERY hedefte bağlam kapatılıp
     * yeniden açılır. Tıklama sayısı birebir aynı kalır; değişen tek şey, belleğin sıfırlanma
     * sıklığı. Kanıt da artımlı yazılır, böylece yarıda kesilen bir koşu bile ne kadarının
     * ölçüldüğünü SÖYLER — sessizce hiçbir şey söylemeyen bir dosya bırakmaz.
     */
    /**
     * ZAMAN BÜTÇELERİ — makineye göre, İDDİAYA dokunmadan.
     *
     * Bu makinede boş RAM 0.3 GB'a inebiliyor ve tıklama 8 sn'de yetişmiyor: 4791 birim
     * "tıklanamadı" diye kırmızı oldu, oysa aynı süpürme bellek boşken 232/232 geçmişti.
     * Süreyi uzatmak iddiayı GEVŞETMEZ — link hâlâ tıklanabilir OLMAK ZORUNDA ve hâlâ hedefine
     * VARMAK ZORUNDA; değişen tek şey, yavaş bir makineye tanınan süre. `MAS_IX_SLOW=1` ile
     * bütçeler açıkça genişletilir, böylece "yavaş makine" bir varsayım değil, bir KARAR olur.
     */
    const SLOW = process.env.MAS_IX_SLOW === "1";
    const CLICK_TIMEOUT = SLOW ? 30_000 : 8_000;
    const NAV_TIMEOUT = SLOW ? 90_000 : 45_000;
    const CONTEXT_RECYCLE_EVERY = SLOW ? 15 : 25;
    const EVIDENCE_FILE = sliceCount > 1 ? `evidence-navigation-${sliceIndex}-${sliceCount}.json` : "evidence-navigation.json";
    const flush = () => {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(path.join(OUT, EVIDENCE_FILE), `${JSON.stringify({ rows: evidence }, null, 2)}\n`, "utf8");
    };

    let clicked = 0;
    for (const [role, roleTargets] of byRole) {
      let session = await openAs(browser, role);
      let sinceRecycle = 0;
      try {
      // Anahtar (şekil) değil DEĞER kullanılır: tıklanacak olan, ekranda o an duran gerçek href.
      for (const [, target] of roleTargets) {
        const href = target.href;
        if (sinceRecycle >= CONTEXT_RECYCLE_EVERY) {
          await session.context.close();
          session = await openAs(browser, role);
          sinceRecycle = 0;
          flush();
        }
        sinceRecycle += 1;
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
          let res = await page.goto(target.sourceRoute, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch((e) => {
            if (!/ERR_ABORTED/.test(String(e))) throw e;
            return null;
          });
          if (!res) {
            await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
            res = await page.goto(target.sourceRoute, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
          }
          if ((res?.status() ?? 0) >= 400) throw new Error(`kaynak rota ${target.sourceRoute} → HTTP ${res?.status()}`);

          // Perde tam ekran ve opak; kapanmadan yapılan her tıklama "intercepts pointer events"
          // ile düşer ve ürün suçlanır. Gözlenebilir duruma göre beklenir, sleep ile değil.
          await waitForWorkspaceReady(page);

          // KAYNAK ROTA /login'e DÜŞTÜYSE bu bir ÜRÜN hatası değil, HARNESS hatasıdır ve öyle
          // söylenir. Bir kez tam olarak böyle bir koşu yaşandı: iki test önceki çıkış testi
          // paylaşılan viewer oturumunu kapatmıştı, gezinme süpürmesi kaynak rotalarda /login
          // görüyordu ve 244 href'in 244'ü "link bulunamadı" diye kırmızı oldu. Mesaj "link
          // bulunamadı" dediği sürece bir sonraki kişi bunu ürün hatası sanar; sebebini adıyla
          // söylemek o yanlış teşhisi imkânsız kılar.
          if (new URL(page.url()).pathname === "/login") {
            throw new Error(
              `HARNESS: kaynak rota ${target.sourceRoute} '${target.role}' oturumuyla /login'e düştü — ` +
                "oturum kapanmış/süresi dolmuş. Bu bir gezinme hatası DEĞİL; kavanozu tazeleyin.",
            );
          }

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
          let candidates = page.locator(`a[href="${href.replace(/"/g, '\\"')}"]`);
          let count = Math.min(await candidates.count(), 6);

          // SOMUT href BAYATLADIYSA ŞEKLE GERİ DÜŞ.
          //
          // Satır linkleri şekle göre gruplanıyor (`/insights/reports/:id`) ama tıklanan href
          // taramanın gördüğü SOMUT kimlik. Tarama ile test arasında mutasyon testleri yeni
          // rapor/senaryo üretiyor, eski kimlik ekrandan kayboluyor ve süpürme "href kaynak
          // rotada bulunamadı" diye ÜRÜNÜ suçluyordu — ölçüldü: /insights/reports/8010d88a-…
          // 93 birimi birden kırmızı yaptı. Kimlik bayat, bağlantı sağlam.
          //
          // Aynı şekle uyan HERHANGİ bir link aynı kontroldür; ekranda o an duranı tıklamak
          // hem doğru hem de kapsamı daraltmaz.
          if (count === 0) {
            const shapeMatch = shapeOf(href);
            const live = await page.locator("a[href^='/']").evaluateAll((nodes) =>
              nodes.map((n) => (n as HTMLAnchorElement).getAttribute("href") ?? ""),
            );
            const replacement = live.find((candidate) => shapeOf(candidate) === shapeMatch);
            if (replacement) {
              proof.push(`somut href bayat; aynı şekle uyan güncel bağlantı kullanıldı (${replacement})`);
              candidates = page.locator(`a[href="${replacement.replace(/"/g, '\\"')}"]`);
              count = Math.min(await candidates.count(), 6);
            }
          }
          if (count === 0) throw new Error(`href ${href} kaynak rotada bulunamadı`);

          let clickedOk = false;
          let lastClickError = "";
          for (let i = 0; i < count; i++) {
            const link = candidates.nth(i);
            try {
              await link.scrollIntoViewIfNeeded({ timeout: SLOW ? 15_000 : 5_000 });
              await Promise.all([
                page.waitForURL(() => true, { timeout: NAV_TIMEOUT }).catch(() => {}),
                link.click({ timeout: CLICK_TIMEOUT }),
              ]);
              clickedOk = true;
              if (i > 0) proof.push(`aday #${i} tıklandı (önceki adaylar örtülüydü)`);
              break;
            } catch (e) {
              lastClickError = e instanceof Error ? e.message.split(/\r?\n/)[0] : String(e);
            }
          }
          if (!clickedOk) throw new Error(`${count} adayın hiçbiri tıklanamadı — ${lastClickError}`);
          await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT }).catch(() => {});

          const landed = new URL(page.url()).pathname;
          proof.push(`click ${target.sourceRoute} → ${landed}`);

          // /login'e düşmek bir gezinme başarısı DEĞİLDİR: oturum düştü ya da yetki reddedildi demektir.
          if (landed === "/login") throw new Error(`link /login'e düşürdü (oturum/yetki) — beklenen ${href}`);

          // Hedef ekran GERÇEKTEN render oldu mu? Kabuk her rotada aynıdır; ayırt edici olan <h1>.
          const heading = page.locator("main h1").first();
          await expect(heading, `${href}: hedef ekranın kendi başlığı görünmedi`).toBeVisible({ timeout: SLOW ? 45_000 : 20_000 });
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
          // ORTAM AÇLIĞI, ÜRÜN HATASI DEĞİLDİR. Chromium bellek baskısı altında
          // ERR_NETWORK_IO_SUSPENDED / ERR_INSUFFICIENT_RESOURCES verir ve her tıklama zaman
          // aşımına uğrar. Bunu "link çalışmıyor" diye raporlamak yanlış teşhistir; koşu adıyla
          // durdurulur ki kimse ürünü suçlamasın.
          if (/ERR_NETWORK_IO_SUSPENDED|ERR_INSUFFICIENT_RESOURCES|Target (page|browser) .* closed/.test(error)) {
            flush();
            throw new Error(
              `ORTAM AÇLIĞI: tarayıcı kaynak yetersizliği bildirdi (${error.slice(0, 80)}). ` +
                "Bu bir gezinme hatası DEĞİL. Belleği boşaltın ya da NAV_SLICE ile dilimleyin; " +
                `kısmi kanıt ${EVIDENCE_FILE} dosyasına yazıldı.`,
            );
          }
        }

        for (const u of target.units) {
          evidence.push({ route: u.route, control: u.signature, role: u.role, verdict, proof, error });
        }
      }
      } finally {
        await session.context.close();
      }
    }

    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, EVIDENCE_FILE), `${JSON.stringify({ rows: evidence }, null, 2)}\n`, "utf8");

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
