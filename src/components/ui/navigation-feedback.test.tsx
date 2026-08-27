// @vitest-environment jsdom
/**
 * AÇILIŞ PERDESİ — kullanıcıyı ne kadar engellediğinin testi.
 *
 * ═══ BU TESTİ DOĞURAN ÖLÇÜM ═══
 *
 * `8007887` bütün workspace rotalarını (60 tane, üçlü gruplar) tam ekran bir perde ARKASINDA
 * ısıtıyordu ve her gruba bir MİNİMUM bekleme dayatıyordu (ilk grup 4000 ms, sonrakiler 700 ms).
 * Süre veriye değil sabit bir bütçeye bağlıydı; üretim derlemesinde ölçülen engelleme **20.0 sn**
 * idi ve perde `pointer-events` serbest bırakmadığı için o süre boyunca HİÇBİR ŞEY tıklanamıyordu.
 *
 * Buradaki iddialar tam olarak o davranışı geri gelemez kılar.
 *
 * ═══ NEDEN SAHTE ZAMANLAYICI (fake timers) ═══
 *
 * Perdenin sözü bir SÜRE sözüdür ("en fazla 5 sn"). Gerçek saatle test etmek ya 5 saniye
 * beklemeyi ya da eşiği gevşetmeyi gerektirirdi; ikisi de yanlış. Sahte zamanlayıcıyla süre
 * DETERMİNİSTİK olarak ileri sarılır ve iddia birebir "5000 ms'de kapanmış olmalı" kalır.
 *
 * `PerformanceObserver` jsdom'da yok; bileşen bunu zaten `typeof … === "undefined"` ile
 * karşılıyor ve gözlemcisiz çalışıyor. Yani bu testte kapanma yolu "ağ sustu" değil, tavan ve
 * sessizlik penceresidir — asıl güvence altına alınmak istenen de odur.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationFeedbackProvider } from "./navigation-feedback";

/* ── next/navigation sahteleri ───────────────────────────────────────────────────────────── */

const prefetch = vi.fn();
const push = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/overview",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ prefetch, push }),
}));

const PRIMARY = ["/overview", "/payments", "/cashflow", "/finance"] as const;
const SECONDARY = ["/payments/items", "/cashflow/monthly", "/finance/checks"] as const;

/** Perde DOM'da mı? Bileşen onu koşullu render eder, gizlemez. */
const curtain = () => document.querySelector("[data-initial-preload]");

function renderProvider(secondary: readonly string[] = SECONDARY) {
  return render(
    <NavigationFeedbackProvider primaryRoutes={PRIMARY} secondaryRoutes={secondary}>
      <a href="/payments">Ödemeler</a>
    </NavigationFeedbackProvider>,
  );
}

beforeEach(() => {
  // MEVCUT ROTAYI JSDOM'A DA KUR. Bileşen "şu an neredeyiz" sorusunu `window.location.pathname`
  // ile cevaplar — `usePathname()` ile DEĞİL — çünkü hazırlık efektinin rota değiştikçe yeniden
  // koşmaması gerekir (deps: [primaryRoutes, secondaryRoutes, router]). jsdom'un varsayılan
  // yolu "/" olduğu için bu kurulmazsa `/overview` "mevcut rota" sayılmaz ve test, üründe
  // olmayan bir davranışı ölçer.
  window.history.replaceState({}, "", "/overview");
  vi.useFakeTimers();
  prefetch.mockClear();
  push.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("açılış perdesi", () => {
  it("ilk açılışta görünür", () => {
    renderProvider();
    // Perde SSR'da da var (`useState({ active: true })`), yani ilk boyamada duruyor.
    expect(curtain(), "perde ilk render'da görünmeli").not.toBeNull();
  });

  it("en fazla 5 saniye içinde kapanır", async () => {
    renderProvider();
    expect(curtain()).not.toBeNull();

    // Tavana kadar ilerlet. Mutlak sınır bu: ağ hiç susmasa bile perde daha uzun duramaz.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(curtain(), "perde 5 sn içinde KAPANMAK ZORUNDA — 20 sn'lik engelleme geri gelemez").toBeNull();
  });

  it("hazırlık erken biterse perdeyi erken kapatır", async () => {
    renderProvider();

    // Sessizlik penceresi 550 ms. jsdom'da PerformanceObserver yok, dolayısıyla hiçbir kaynak
    // gözlenmez ve ağ "baştan sessiz" sayılır: perde tavanı BEKLEMEDEN kapanmalı.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(curtain(), "ağ sessizse perde 5 sn'yi beklemeden kapanmalı").toBeNull();
  });

  it("perde kapanınca ana menü tıklanabilir", async () => {
    renderProvider();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(curtain()).toBeNull();

    // Perde gittiğine göre link tıklanabilir olmalı: üstünü kapatan tam ekran katman yok ve
    // bileşenin yakalayıcı click dinleyicisi gezinmeyi devralıyor.
    const link = screen.getByRole("link", { name: "Ödemeler" });
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(push, "perde kapandıktan sonra tıklama gezinmeyi başlatmalı").toHaveBeenCalledWith("/payments");
  });

  it("arka plan hazırlığı sürerken UI tıklanabilir kalır", async () => {
    renderProvider();

    // Perdeyi kapat, ama arka plan zincirini BİTİRME: alt sekmeler hâlâ ısınıyor olacak.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(curtain()).toBeNull();

    // Zincirin ilk adımı çalışsın, ama hepsi bitmesin.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const link = screen.getByRole("link", { name: "Ödemeler" });
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await vi.advanceTimersByTimeAsync(50);
    });

    // Asıl iddia: arka plan prefetch'i etkileşimi ENGELLEMİYOR.
    expect(push, "arka plan ısıtması sürerken de tıklama çalışmalı").toHaveBeenCalledWith("/payments");
    expect(curtain(), "arka plan fazında perde geri gelmemeli").toBeNull();
  });

  it("unmount olduğunda zamanlayıcı/gözlemci temizlenir ve prefetch devam etmez", async () => {
    const view = renderProvider();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    const afterCurtain = prefetch.mock.calls.length;

    view.unmount();

    // Sökülmüş bir ağaç adına iş yapılmamalı: ne bekleyen idle/timeout zinciri, ne yeni prefetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(prefetch.mock.calls.length, "unmount sonrası yeni prefetch yapılmamalı").toBe(afterCurtain);
    expect(vi.getTimerCount(), "unmount sonrası bekleyen zamanlayıcı kalmamalı").toBe(0);
  });
});

describe("rol filtresi", () => {
  it("yalnız kendisine verilen rotaları ısıtır — listelerin dışına çıkmaz", async () => {
    renderProvider();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    const warmed = new Set(prefetch.mock.calls.map((call) => call[0] as string));
    // `/overview` mevcut rota olduğu için elenmeli; kalan her şey verilen iki listeden gelmeli.
    const allowed = new Set<string>([...PRIMARY, ...SECONDARY]);
    for (const href of warmed) {
      expect(allowed.has(href), `${href} verilen listelerde yok — rol filtresi delinmiş olurdu`).toBe(true);
    }
    expect(warmed.has("/overview"), "mevcut rota yeniden ısıtılmamalı").toBe(false);
  });
});
