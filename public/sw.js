// MAS Nakit Radar - Service Worker v1.0.0
const CACHE_NAME = "mas-radar-v1";
const STATIC_ASSETS = [
  "/",
  "/manifest.json",
  "/icon.svg",
  "/telegram/miniapp"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn("[SW] Cache preload warning:", err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and chrome-extension/internal requests
  if (event.request.method !== "GET" || !url.protocol.startsWith("http")) {
    return;
  }

  // Network-first for API and dynamic pages; cache-first for static icons & manifest
  const isStatic = url.pathname.endsWith(".svg") ||
                   url.pathname.endsWith(".png") ||
                   url.pathname.endsWith(".ico") ||
                   url.pathname === "/manifest.json";

  if (isStatic) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Network first with cache fallback for HTML pages
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          const fallback = await caches.match("/telegram/miniapp");
          if (fallback) return fallback;
          return new Response(
            `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><title>Çevrimdışı - MAS Radar</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#090d16;color:#f8fafc;font-family:sans-serif;padding:32px;text-align:center;"><h2>İnternet Bağlantısı Yok</h2><p style="color:#94a3b8">MAS Nakit Radar şu an çevrimdışı. Bağlantınızı kontrol edin.</p></body></html>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        })
    );
    return;
  }

  // Normal fetch for API & data
  event.respondWith(
    fetch(event.request).catch(async () => {
      return caches.match(event.request);
    })
  );
});

// Push notification handling
self.addEventListener("push", (event) => {
  let payload = { title: "MAS Nakit Radar", body: "Yeni finansal bildirim mevcut.", url: "/telegram/miniapp" };
  try {
    if (event.data) {
      payload = { ...payload, ...event.data.json() };
    }
  } catch (e) {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: payload.url || "/telegram/miniapp" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === targetUrl && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
