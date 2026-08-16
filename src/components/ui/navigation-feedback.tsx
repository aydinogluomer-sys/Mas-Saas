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

const IDLE_PREFETCH_ROUTES = ["/overview", "/payments", "/cashflow", "/finance", "/production", "/scenarios", "/insights/ask", "/data/quality", "/system"];
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

export function NavigationFeedbackProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<NavigationState>({ pendingHref: null, isNavigating: false, startedAt: null });
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStuckTimer = useCallback(() => {
    if (stuckTimer.current !== null) {
      clearTimeout(stuckTimer.current);
      stuckTimer.current = null;
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
    if (process.env.NODE_ENV !== "production") return;
    if (window.sessionStorage.getItem("mas:primary-prefetch") === "done") return;
    window.sessionStorage.setItem("mas:primary-prefetch", "done");
    let index = 0;
    const run = () => {
      const href = IDLE_PREFETCH_ROUTES[index++];
      if (href) router.prefetch(href);
      if (index < IDLE_PREFETCH_ROUTES.length) window.setTimeout(schedule, 750);
    };
    const idleApi = window as unknown as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const requestIdle = idleApi.requestIdleCallback;
    const schedule = () => requestIdle ? requestIdle(run, { timeout: 1_500 }) : window.setTimeout(run, 300);
    const id = schedule();
    return () => requestIdle ? idleApi.cancelIdleCallback?.(id) : window.clearTimeout(id);
  }, [router]);

  const value: NavigationContextValue = { ...state, beginNavigation, prefetch: (href) => router.prefetch(href) };
  return <NavigationContext.Provider value={value}>
    <div data-navigation-root className={state.isNavigating ? "navigation-pending" : ""} aria-busy={state.isNavigating || undefined}>
      <div className="navigation-progress" aria-hidden />
      <span className="sr-only" role="status" aria-live="polite">{state.isNavigating ? "Sayfa yükleniyor" : ""}</span>
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
