"use client";

import { createContext, startTransition, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface NavigationState {
  pendingHref: string | null;
  isNavigating: boolean;
  startedAt: number | null;
}

interface NavigationContextValue extends NavigationState {
  beginNavigation: (href: string) => void;
  prefetch: (href: string) => void;
}

/** A client navigation that never commits used to leave the pending UI up forever: the
 * skeleton stayed visible, aria-busy stayed "true" and the clicked links stayed .is-pending,
 * because the only thing that clears that state is the effect keyed on [pathname], and the
 * pathname never changes when the navigation dies (Bulgu #8). This is the deadline after
 * which we stop waiting and send the browser to the destination ourselves — the user both
 * gets unstuck AND arrives, rather than being left staring at a skeleton.
 * 3s is deliberately far above a healthy client navigation (measured ~100ms here), so a
 * merely slow-but-working transition will not trip it. */
const STUCK_NAVIGATION_TIMEOUT_MS = 3000;

const NavigationContext = createContext<NavigationContextValue | null>(null);

/* ── Açılış hazırlığı: perde ne kadar kalır, arkasında ne ısınır ────────────────────────────
 *
 * NE ÖLÇÜLDÜ (düzeltmeden önce). Perde bütün workspace rotaları — 60 tanesi, üçlü gruplar
 * hâlinde — bitene kadar kapanmıyordu ve `waitForResourceQuiet(minimumWaitMs)` her gruba bir
 * MİNİMUM dayatıyordu (ilk grup 4000 ms, sonrakiler 700 ms). Yani süre veriye değil, sabit bir
 * bütçeye bağlıydı:
 *
 *     4000 + 19 × 700 + 250 ≈ 17.5 sn teorik    →    20.0 sn ölçüldü
 *
 * `.workspace-preloader` tam ekran, opak ve `pointer-events` serbest bırakılmamış; dolayısıyla
 * bu sürenin tamamı boyunca kullanıcı HİÇBİR ŞEYE tıklayamıyordu. `useState({ active: true })`
 * olduğu için perde SSR HTML'inde de var: her tam reload ve her yer imi açılışı 20 sn bekliyordu.
 *
 * ═══ YENİ DAVRANIŞ ═══
 *
 *   BLOKLAYAN FAZ   Yalnız role göre görünen ANA SIDEBAR rotaları (en çok 9, mevcut rota hariç).
 *                   Hepsi tek seferde prefetch edilir; ağ sessizleşince perde HEMEN kapanır.
 *   MUTLAK TAVAN    5 sn. Ağ hiç sessizleşmese bile perde bu süreden fazla duramaz.
 *   ARKA PLAN FAZ   Alt sekmeler perde KAPANDIKTAN sonra, boşta, TEK TEK ısıtılır.
 *
 * Alt sekmelerin bloklayan fazdan çıkarılması iki şeyi birden düzeltir: bekleme 60 rotaya değil
 * ~9 rotaya bağlanır, ve asıl maliyet (ilk chunk/derleyici ısınması) zaten ilk gruba düşer.
 *
 * ═══ NEDEN "MİNİMUM BEKLEME" KALDIRILDI ═══
 *
 * Eski `minimumWaitMs`, hazırlık erken bitse bile beklemeyi ZORUNLU kılıyordu — kapanma
 * koşulunu ölçümden koparan şey buydu. Yeni koşul yalnız iki şey: ağ `PRELOAD_QUIET_MS` kadar
 * sessiz kaldı mı, ya da tavana ulaşıldı mı. Sessizlik penceresinin kendisi (550 ms) perdenin
 * göz kırpmasını da engelliyor; ayrıca yapay bir taban gerekmiyor.
 */
const PRELOAD_QUIET_MS = 550;
/** Perdenin MUTLAK üst sınırı. Aşılamaz; ağ hiç susmasa bile kullanıcı burada serbest kalır. */
const PRELOAD_CURTAIN_MAX_MS = 5_000;
/** İlerleme çubuğunun tazelenme aralığı — yalnız görsel. */
const PRELOAD_PROGRESS_TICK_MS = 100;

/**
 * Ağ sessizleşene YA DA tavana ulaşılana kadar bekle; hangisi önce olursa.
 *
 * `onProgress`, geçen sürenin tavana oranını bildirir. İlerleme çubuğu artık "kaç rota bitti"
 * değil "ne kadar beklendi" gösterir — çünkü bloklayan fazda bütün prefetch'ler aynı anda
 * başlatılıyor ve rota başına anlamlı bir ilerleme YOK. Sahte bir yüzde göstermektense
 * ölçülebilir olanı göstermek doğrusu.
 */
function waitForWorkspaceWarm(signal: AbortSignal, onProgress: (ratio: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let lastResourceAt = startedAt;

    const deadlineTimer = window.setTimeout(finish, PRELOAD_CURTAIN_MAX_MS);
    const pollTimer = window.setInterval(() => {
      const now = performance.now();
      onProgress(Math.min((now - startedAt) / PRELOAD_CURTAIN_MAX_MS, 1));
      // ERKEN KAPANMA: ağ sustuysa tavanı beklemeden çık.
      if (now - lastResourceAt >= PRELOAD_QUIET_MS) finish();
    }, PRELOAD_PROGRESS_TICK_MS);

    const observer = typeof PerformanceObserver === "undefined" ? null : new PerformanceObserver(() => {
      lastResourceAt = performance.now();
    });

    function finish() {
      window.clearInterval(pollTimer);
      window.clearTimeout(deadlineTimer);
      observer?.disconnect();
      signal.removeEventListener("abort", finish);
      resolve();
    }

    observer?.observe({ type: "resource", buffered: false });
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * İşi tarayıcı BOŞTAYKEN çalıştır; iptal edilebilir bir temizleyici döndür.
 *
 * `requestIdleCallback` Safari'de yok — orada `setTimeout`'a düşülür. Fallback'in gecikmesi
 * bilerek küçük ama sıfır değil: sıfır olsaydı arka plan ısıtması ana iş parçacığını arka arkaya
 * meşgul eder ve "arka plan prefetch etkileşimi engellemesin" sözünü Safari'de bozardı.
 */
function scheduleWhenIdle(run: () => void): () => void {
  const view = window as Window & {
    requestIdleCallback?: (cb: IdleRequestCallback, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof view.requestIdleCallback === "function") {
    // `timeout`: tarayıcı hiç boşalmazsa iş süresiz ertelenmesin.
    const handle = view.requestIdleCallback(() => run(), { timeout: 2_000 });
    return () => view.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(run, 200);
  return () => window.clearTimeout(handle);
}

function localHref(anchor: HTMLAnchorElement): string | null {
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;
  const raw = anchor.getAttribute("href");
  if (!raw || raw.startsWith("#")) return null;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * `primaryRoutes` PERDEYİ TUTAR, `secondaryRoutes` TUTMAZ — ayrım bilerek prop seviyesinde.
 *
 * Rol filtresi ÇAĞIRANDA uygulanır (`navigationFor` + `canSeeRoute`, bkz. dashboard layout) ve
 * burada korunur: bu bileşen kendisine verilen listelerin dışına çıkmaz, yani bir katmanın
 * göremediği rota ne bloklayan fazda ne arka planda ısıtılır.
 */
export function NavigationFeedbackProvider({
  children,
  primaryRoutes,
  secondaryRoutes = [],
}: {
  children: ReactNode;
  /** Role göre görünen ANA sidebar rotaları — perde bunlar için bekler. */
  primaryRoutes: readonly string[];
  /** Alt sekmeler — perde KAPANDIKTAN sonra, boşta, tek tek ısıtılır. */
  secondaryRoutes?: readonly string[];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<NavigationState>({ pendingHref: null, isNavigating: false, startedAt: null });
  const [preload, setPreload] = useState({ active: true, progress: 0 });
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStuckTimer = useCallback(() => {
    if (stuckTimer.current !== null) {
      clearTimeout(stuckTimer.current);
      stuckTimer.current = null;
    }
  }, []);
  const prefetch = useCallback((href: string) => router.prefetch(href), [router]);

  const beginNavigation = useCallback((href: string) => {
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (href === currentHref || href.startsWith(`${currentHref}#`)) return;
    const root = document.querySelector<HTMLElement>("[data-navigation-root]");
    root?.classList.add("navigation-pending");
    root?.setAttribute("aria-busy", "true");
    document.querySelectorAll<HTMLElement>(".is-pending").forEach((element) => element.classList.remove("is-pending"));
    document.querySelectorAll<HTMLElement>('[aria-current="page"]').forEach((element) => element.removeAttribute("aria-current"));
    document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
      const url = new URL(anchor.href, window.location.href);
      if (`${url.pathname}${url.search}${url.hash}` === href) {
        anchor.setAttribute("aria-current", "page");
        anchor.classList.add("is-pending");
      }
    });
    // If the navigation still has not committed by the deadline, hand the URL to the browser.
    // Guarded on the location being unchanged so we never hijack a navigation that did land, or
    // one the user started somewhere else in the meantime.
    clearStuckTimer();
    stuckTimer.current = setTimeout(() => {
      stuckTimer.current = null;
      const nowHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (nowHref !== currentHref) return;
      window.location.href = href;
    }, STUCK_NAVIGATION_TIMEOUT_MS);
    startTransition(() => setState({ pendingHref: href, isNavigating: true, startedAt: performance.now() }));
  }, [clearStuckTimer]);

  useEffect(() => {
    // The navigation committed — the deadline above is no longer needed.
    clearStuckTimer();
    setState((current) => current.isNavigating ? { pendingHref: null, isNavigating: false, startedAt: null } : current);
  }, [pathname, searchParams, clearStuckTimer]);

  useEffect(() => clearStuckTimer, [clearStuckTimer]);

  useEffect(() => {
    document.documentElement.dataset.navigationReady = "true";
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a") : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      // Escape hatch: an anchor marked data-hard-nav is left entirely alone — no
      // preventDefault, no router.push — so the browser performs a real, full page
      // navigation, exactly as typing the URL does. Used for the routes where the
      // client transition silently aborts (Bulgu #7, root cause still unknown); it is
      // also the general lever if that failure shows up anywhere else.
      if (target.hasAttribute("data-hard-nav")) return;
      const href = localHref(target);
      const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (!href || href === currentHref || href.startsWith(`${currentHref}#`)) return;
      event.preventDefault();
      event.stopPropagation();
      beginNavigation(href);
      window.dispatchEvent(new CustomEvent("mas:navigation-start"));
      window.requestAnimationFrame(() => router.push(href));
    };
    document.addEventListener("click", onClick, true);
    return () => {
      delete document.documentElement.dataset.navigationReady;
      document.removeEventListener("click", onClick, true);
    };
  }, [beginNavigation, router]);

  useEffect(() => {
    const controller = new AbortController();
    const here = window.location.pathname;
    const primary = primaryRoutes.filter((href) => href !== here);
    const secondary = secondaryRoutes.filter((href) => href !== here && !primary.includes(href));

    // Arka plan zincirinin o anki iptal edicisi. Unmount'ta beklemedeki idle/timeout işi de
    // iptal edilir — aksi hâlde sökülmüş bir ağaç adına prefetch tetiklenmeye devam ederdi.
    let cancelPending: (() => void) | null = null;

    const warmWorkspace = async () => {
      // ── 1) BLOKLAYAN FAZ: yalnız ana sidebar rotaları ─────────────────────────────────
      if (primary.length > 0) {
        primary.forEach((href) => router.prefetch(href));
        await waitForWorkspaceWarm(controller.signal, (ratio) => {
          setPreload((current) => (current.active ? { active: true, progress: ratio } : current));
        });
      }
      if (controller.signal.aborted) return;

      // Perde burada kapanır: en geç 5 sn, ağ daha erken susarsa daha erken.
      setPreload({ active: false, progress: 1 });

      // ── 2) ARKA PLAN FAZ: alt sekmeler, boşta, TEK TEK ────────────────────────────────
      //
      // Tek tek olması önemli: hepsini birden atmak ağı ve ana iş parçacığını doldurup
      // kullanıcının o an yaptığı gezinmeyi yavaşlatırdı. Perde çoktan kapalı olduğu için
      // bu faz hiçbir tıklamayı veya klavye etkileşimini ENGELLEMEZ — yalnız boş zamanı
      // kullanır.
      let index = 0;
      const warmNext = () => {
        if (controller.signal.aborted || index >= secondary.length) return;
        router.prefetch(secondary[index]);
        index += 1;
        cancelPending = scheduleWhenIdle(warmNext);
      };
      cancelPending = scheduleWhenIdle(warmNext);
    };

    void warmWorkspace();
    return () => {
      controller.abort();
      cancelPending?.();
    };
  }, [primaryRoutes, secondaryRoutes, router]);

  const value: NavigationContextValue = { ...state, beginNavigation, prefetch };
  return <NavigationContext.Provider value={value}>
    <div data-navigation-root className={state.isNavigating ? "navigation-pending" : ""} aria-busy={state.isNavigating || undefined}>
      <div className="navigation-progress" aria-hidden />
      <span className="sr-only" role="status" aria-live="polite">{state.isNavigating ? "Sayfa yükleniyor" : ""}</span>
      {preload.active && <div className="workspace-preloader" data-initial-preload role="status" aria-live="polite" aria-label="Uygulama hazırlanıyor">
        <div className="workspace-preloader-card">
          <span className="workspace-preloader-mark" aria-hidden>MAS</span>
          <h1>Uygulama hazırlanıyor</h1>
          <p>Sayfalar ilk tıklamanızdan önce hızlandırılıyor.</p>
          <div className="workspace-preloader-track" aria-hidden><i style={{ width: `${Math.round(preload.progress * 100)}%` }} /></div>
          <small>{Math.round(preload.progress * 100)}%</small>
        </div>
      </div>}
      <div className="instant-navigation-skeleton" aria-hidden="true">
        <div className="instant-skeleton-title skeleton-block" />
        <div className="loading-kpis">{Array.from({ length: 4 }, (_, index) => <div className="skeleton-card" key={index}><i /><b /></div>)}</div>
        <div className="skeleton-chart"><i /><i /><i /><i /></div>
      </div>
      {children}
    </div>
  </NavigationContext.Provider>;
}

export function useNavigationFeedback() {
  const value = useContext(NavigationContext);
  if (!value) throw new Error("useNavigationFeedback must be used inside NavigationFeedbackProvider");
  return value;
}

export function prefetchLinkHandlers(prefetch: (href: string) => void, href: string) {
  return {
    onMouseEnter: () => prefetch(href),
    onFocus: () => prefetch(href),
  };
}
