// @vitest-environment jsdom
/**
 * GEZİNME GERİ BİLDİRİMİ — açılış perdesi ve rota ısıtması OLMADAN.
 *
 * ═══ BU TESTİN SÖYLEDİĞİ ═══
 *
 * Sağlayıcı eskiden her tam sayfa yüklemesinde rol-görünür sidebar rotalarını, sonra boşta ~60 alt
 * sekmeyi `router.prefetch()` ile ısıtıyor, ilk fazı sunucuda render edilen tam ekran bir perdenin
 * (`[data-initial-preload]`) arkasında yapıyordu; sidebar ve modül sekmeleri de her hover/focus'ta
 * aynı çağrıyı yapıyordu. Next 15.5'te (`clientSegmentCache` kapalı) `router.prefetch(href)` TAM bir
 * prefetch'tir: sunucu sayfanın tamamını render eder — GET sırasında yazan sayfalar dahil — ve
 * istemci bu render'ı 5 dakikaya kadar yeniden kullanır. Wave 0 bunların hepsini kaldırdı.
 *
 * Buradaki iddialar iki şeyi kilitler:
 *   · kaldırılan davranış geri gelemez — perde yok, açılışta ve zamanla prefetch yok, bağlam ve
 *     modül bir prefetch yolu dağıtmaz, sekme üzerine gelmek/odaklanmak prefetch tetiklemez;
 *   · tutulan davranış çalışır — tıklama yakalama + `router.push`, Playwright'ın beklediği
 *     `navigationReady` bayrağı, unmount'ta zamanlayıcı bırakmama.
 *
 * Sahte zamanlayıcılar: "hiç prefetch yok" iddiası zamana bağlı bir iddiadır (eski kod perde
 * kapandıktan SONRA da boşta ısıtmaya devam ediyordu); süre deterministik olarak ileri sarılır.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationFeedbackProvider, useNavigationFeedback } from "./navigation-feedback";
import { ModuleFrame } from "./module-tabs";

/* ── next/navigation sahteleri ───────────────────────────────────────────────────────────── */

const prefetch = vi.fn();
const push = vi.fn();
// Üründe olduğu gibi KARARLI kimlikler: gerçek `useRouter`/`useSearchParams` URL değişmedikçe aynı
// nesneyi döndürür. Her render'da yeni nesne döndürmek, [pathname, searchParams] efektini her
// render'da yeniden koşturup tıklamanın kurduğu zamanlayıcıları siler ve test, üründe olmayan
// bir davranışı ölçerdi.
const router = { prefetch, push };
const searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/overview",
  useSearchParams: () => searchParams,
  useRouter: () => router,
}));

/** Eski perdenin işaretçisi. Bileşen onu koşullu render ederdi; artık hiç render etmemeli. */
const curtain = () => document.querySelector("[data-initial-preload]");

let contextValue: ReturnType<typeof useNavigationFeedback> | null = null;
function ContextProbe() {
  contextValue = useNavigationFeedback();
  return null;
}

function renderProvider() {
  return render(
    <NavigationFeedbackProvider>
      <ContextProbe />
      <a href="/payments">Ödemeler</a>
    </NavigationFeedbackProvider>,
  );
}

async function clickPaymentsLink() {
  const link = screen.getByRole("link", { name: "Ödemeler" });
  await act(async () => {
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
}

beforeEach(() => {
  // Bileşen "şu an neredeyiz" sorusunu `window.location` ile cevaplar; jsdom'un varsayılanı "/"
  // olduğu için mevcut rota burada da kurulur.
  window.history.replaceState({}, "", "/overview");
  vi.useFakeTimers();
  prefetch.mockClear();
  push.mockClear();
  contextValue = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("açılış: perde ve rota ısıtması yok", () => {
  it("ilk render'da açılış perdesi yok", () => {
    renderProvider();
    expect(curtain(), "perde kaldırıldı — ilk render'da (SSR dahil) görünmemeli").toBeNull();
  });

  it("açılışta ve zaman geçtikçe hiçbir rota prefetch edilmez", async () => {
    renderProvider();
    expect(prefetch, "mount sırasında prefetch yapılmamalı").not.toHaveBeenCalled();

    // Eski ısıtma perde kapandıktan sonra da boşta, tek tek sürüyordu; uzun bir süre ileri sar.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(prefetch, "zaman geçince de arka planda prefetch yapılmamalı").not.toHaveBeenCalled();
    expect(curtain(), "perde sonradan da belirmemeli").toBeNull();
  });

  it("bağlam ve modül bir prefetch yolu dağıtmaz", async () => {
    renderProvider();
    expect(contextValue, "bağlam okunamadı").not.toBeNull();
    expect(Object.keys(contextValue ?? {}), "bağlamda TAM prefetch işlevi olmamalı").not.toContain("prefetch");

    const mod = await import("./navigation-feedback");
    expect(Object.keys(mod), "hover/focus prefetch yardımcısı geri gelmemeli").not.toContain("prefetchLinkHandlers");
  });

  it("modül sekmesinin üzerine gelmek veya odaklanmak prefetch tetiklemez", () => {
    render(
      <NavigationFeedbackProvider>
        <ModuleFrame
          title="Finansman"
          description=""
          tabs={[
            { href: "/finance", label: "Özet" },
            { href: "/finance/checks", label: "Çekler" },
            { href: "/finance/loans", label: "Krediler" },
          ]}
        >
          <p>içerik</p>
        </ModuleFrame>
      </NavigationFeedbackProvider>,
    );

    const tab = screen.getByRole("link", { name: "Çekler" });
    fireEvent.mouseEnter(tab);
    fireEvent.focus(tab);

    // Eski sekme işleyicileri burada `router.prefetch("/finance/checks")` çağırırdı.
    expect(prefetch, "hover/focus TAM prefetch yapmamalı").not.toHaveBeenCalled();
  });
});

describe("tutulan gezinme davranışı", () => {
  it("navigationReady bayrağını kurar ve unmount'ta kaldırır", () => {
    const view = renderProvider();
    // Playwright ve scripts/measure-navigation.ts "kabuk hydrate oldu" işareti olarak bunu bekler.
    expect(document.documentElement.dataset.navigationReady).toBe("true");

    view.unmount();
    expect(document.documentElement.dataset.navigationReady).toBeUndefined();
  });

  it("yerel bir linke tıklamak gezinmeyi router.push ile başlatır", async () => {
    renderProvider();
    await clickPaymentsLink();

    expect(push, "tıklama gezinmeyi başlatmalı").toHaveBeenCalledWith("/payments");
    expect(prefetch, "tıklama da prefetch tetiklememeli").not.toHaveBeenCalled();
  });

  it("unmount olduğunda bekleyen zamanlayıcı kalmaz", async () => {
    const view = renderProvider();
    await clickPaymentsLink();

    // Tıklama iki zamanlayıcı kurar: 110 ms iskelet gecikmesi ve 3 sn takılı-gezinme tavanı.
    // Önce kurulduklarını gör; yoksa aşağıdaki "sıfır" iddiası hiçbir şey kanıtlamazdı.
    expect(vi.getTimerCount(), "tıklama zamanlayıcı kurmalıydı").toBeGreaterThan(0);

    view.unmount();
    expect(vi.getTimerCount(), "unmount sonrası bekleyen zamanlayıcı kalmamalı").toBe(0);
  });
});
