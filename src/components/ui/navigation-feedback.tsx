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
 * Click feedback for client navigations: pending state, the skeleton, and the stuck-navigation
 * deadline. It deliberately does NOT warm routes.
 *
 * Wave 0 removed the opening warm-up that used to live here: on every full page load it called
 * `router.prefetch()` for the role-visible sidebar routes behind a full-screen curtain rendered
 * on the server, then for up to ~60 sub-tabs while idle; the sidebar and the module tabs also
 * called it on every hover and focus. Without `clientSegmentCache`, `router.prefetch(href)` in
 * Next 15.5 is a FULL prefetch — the server renders the whole page, including the pages that
 * write during GET (/payments/calendar, /payments/missing, /cashflow/controls), on behalf of a
 * user who only opened the app — and the client reuses that render for up to five minutes, so a
 * click could show figures captured minutes earlier. Links keep next/link's default (AUTO)
 * prefetch, which stops at the nearest loading boundary instead of rendering the page itself.
 */
export function NavigationFeedbackProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<NavigationState>({ pendingHref: null, isNavigating: false, startedAt: null });
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
    // Guarded on the location being unchanged so we never hijack a navigation that did land, or
    // one the user started somewhere else in the meantime.
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
      // 16ms'lik yapay rAF gecikmesi kaldırıldı — yönlendirme anında başlar
      router.push(href);
    };
    document.addEventListener("click", onClick, true);
    return () => {
      delete document.documentElement.dataset.navigationReady;
      document.removeEventListener("click", onClick, true);
    };
  }, [beginNavigation, router]);

  const value: NavigationContextValue = { ...state, beginNavigation };
  return <NavigationContext.Provider value={value}>
    <div data-navigation-root className={state.isNavigating ? "navigation-pending" : ""} aria-busy={state.isNavigating || undefined}>
      <div className="navigation-progress" aria-hidden />
      <span className="sr-only" role="status" aria-live="polite">{state.isNavigating ? "Sayfa yükleniyor" : ""}</span>
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
