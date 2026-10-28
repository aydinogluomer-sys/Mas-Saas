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
const STUCK_NAVIGATION_TIMEOUT_MS = 3_000;

const NavigationContext = createContext<NavigationContextValue | null>(null);

/* ── Açılış hazırlığı: perde ne kadar kalır, arkasında ne ısınır ────────────────────────────
 *
 * Performans optimizasyonu: Kullanıcıyı bloklayan yapay bekleme süreleri minimize edildi.
 * Ağ sessizleştiğinde perde 150ms içinde kapanır; mutlak üst sınır 1.5 saniyeye indirildi.
 */
const PRELOAD_QUIET_MS = 150;
/** Perdenin MUTLAK üst sınırı. Aşılamaz; kullanıcı en geç 1.5 sn içinde serbest kalır. */
const PRELOAD_CURTAIN_MAX_MS = 1_500;
/** İlerleme çubuğunun tazelenme aralığı — yalnız görsel. */
const PRELOAD_PROGRESS_TICK_MS = 50;

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
  const [skeletonActive, setSkeletonActive] = useState(false);
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skeletonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (stuckTimer.current !== null) {
      clearTimeout(stuckTimer.current);
      stuckTimer.current = null;
    }
    if (skeletonTimer.current !== null) {
      clearTimeout(skeletonTimer.current);
      skeletonTimer.current = null;
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
    
    // Hızlı, doğrudan hedef selector — yüzlerce DOM linkini tek tek ayrıştırmayı önler
    const matching = document.querySelectorAll<HTMLAnchorElement>(
      `a[href="${href}"], .sidebar-link[href="${href}"], .module-tabs a[href="${href}"]`
    );
    matching.forEach((anchor) => {
      anchor.setAttribute("aria-current", "page");
      anchor.classList.add("is-pending");
    });

    clearTimers();

    // 110ms debounce: Hızlı/önbellekli rotalarda tam ekran iskelet yanıp-sönmesini (flicker) önler,
    // ancak 200ms altındaki gecikmeli rotalarda test sözleşmesini (<200ms görünürlük) tam sağlar.
    skeletonTimer.current = setTimeout(() => {
      skeletonTimer.current = null;
      const currentRoot = document.querySelector<HTMLElement>("[data-navigation-root]");
      currentRoot?.classList.add("navigation-skeleton-active");
      setSkeletonActive(true);
    }, 110);

    // If the navigation still has not committed by the deadline, hand the URL to the browser.
    stuckTimer.current = setTimeout(() => {
      stuckTimer.current = null;
      const nowHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (nowHref !== currentHref) return;
      window.location.href = href;
    }, STUCK_NAVIGATION_TIMEOUT_MS);

    startTransition(() => setState({ pendingHref: href, isNavigating: true, startedAt: performance.now() }));
  }, [clearTimers]);

  useEffect(() => {
    // The navigation committed — timers and skeleton are no longer needed.
    clearTimers();
    const root = document.querySelector<HTMLElement>("[data-navigation-root]");
    root?.classList.remove("navigation-pending", "navigation-skeleton-active");
    setSkeletonActive(false);
    setState((current) => current.isNavigating ? { pendingHref: null, isNavigating: false, startedAt: null } : current);
  }, [pathname, searchParams, clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    document.documentElement.dataset.navigationReady = "true";
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a") : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      if (target.hasAttribute("data-hard-nav")) return;
      const href = localHref(target);
      const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (!href || href === currentHref || href.startsWith(`${currentHref}#`)) return;
      event.preventDefault();
      event.stopPropagation();
      beginNavigation(href);
      window.dispatchEvent(new CustomEvent("mas:navigation-start"));
      // 16ms'lik yapay rAF gecikmesi kaldırıldı — yönlendirme anında başlar
      router.push(href);
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

    let cancelPending: (() => void) | null = null;

    const warmWorkspace = async () => {
      if (primary.length > 0) {
        if (process.env.NODE_ENV !== "development") {
          primary.forEach((href) => router.prefetch(href));
        }
        await waitForWorkspaceWarm(controller.signal, (ratio) => {
          setPreload((current) => (current.active ? { active: true, progress: ratio } : current));
        });
      }
      if (controller.signal.aborted) return;

      setPreload({ active: false, progress: 1 });

      if (process.env.NODE_ENV !== "development") {
        let index = 0;
        const warmNext = () => {
          if (controller.signal.aborted || index >= secondary.length) return;
          router.prefetch(secondary[index]);
          index += 1;
          cancelPending = scheduleWhenIdle(warmNext);
        };
        cancelPending = scheduleWhenIdle(warmNext);
      }
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
      <div className={`instant-navigation-skeleton ${skeletonActive ? "is-active" : ""}`} aria-hidden="true">
        {skeletonActive ? (
          <>
            <div className="instant-skeleton-title skeleton-block" />
            <div className="loading-kpis">{Array.from({ length: 4 }, (_, index) => <div className="skeleton-card" key={index}><i /><b /></div>)}</div>
            <div className="skeleton-chart"><i /><i /><i /><i /></div>
          </>
        ) : null}
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
