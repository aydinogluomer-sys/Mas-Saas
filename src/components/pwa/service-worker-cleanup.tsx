"use client";

// Wave 0 — removes the caching service worker the unreviewed layer installed, from the page side.
//
// The layer's PwaRegister registered /sw.js on every page, and that worker kept a copy of every
// financial screen the user opened in Cache Storage, readable offline and after logout. Its
// install banner also promised "çevrimdışı destek" — offline support for a dashboard whose rule is
// that the database is the only source of truth. Both are gone: nothing in this app registers a
// service worker any more (tests/pwa-assets.test.ts fails if anything does).
//
// public/sw.js is now a kill-switch that unregisters itself once a browser fetches it. This
// component is the second, independent half: on every page load it unregisters whatever worker
// this origin still has and deletes every Cache Storage entry, so a device is cleaned even if the
// worker update never ran (an update check that failed, a browser that kept the old worker
// waiting). Both calls are cheap no-ops once a device is clean. It renders nothing.
//
// Remove this component together with public/sw.js after one release, once the owner's devices
// show no registration and an empty Cache Storage (docs/todo.md, Wave 0 / S6).
import { useEffect } from "react";

export function ServiceWorkerCleanup() {
  useEffect(() => {
    // Plain-http access from another machine is not a secure context: neither API exists there,
    // and neither could a worker have been installed. A rejected call is ignored on purpose — the
    // page works the same either way, the next load tries again, and the kill-switch worker
    // covers the same ground from the other side.
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
        .catch(() => undefined);
    }
    if ("caches" in window) {
      void caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => undefined);
    }
  }, []);

  return null;
}
