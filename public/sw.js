// MAS Nakit Radar — service worker KILL-SWITCH (Wave 0). It caches nothing and serves nothing.
//
// WHY THIS FILE STILL EXISTS. The unreviewed layer shipped a worker that precached "/" and the
// Telegram mini-app, stored EVERY page the user opened in Cache Storage and served those copies
// offline — financial screens readable from the browser's disk after logout, with no session
// check. Deleting this file would not remove that worker from a browser that already installed
// it: a missing script makes the update check fail, and the installed worker simply stays. The
// only way to retire it is to replace it with a worker that removes itself.
//
// WHAT HAPPENS ON A DEVICE THAT HAS THE OLD WORKER. On its next page load the browser fetches
// /sw.js (middleware keeps it public — a redirect to /login would fail the update the same way),
// sees new bytes, installs this one; skipWaiting() activates it at once and clients.claim() makes
// it the controller of the open tabs. It has NO fetch handler, so from that moment every request
// goes to the network and nothing is answered from a cache. It then deletes every cache of this
// origin and unregisters itself. Open tabs are not reloaded: with no fetch handler they are
// already safe, and a forced reload would throw away whatever the user was typing.
//
// The page-side half is src/components/pwa/service-worker-cleanup.tsx. Both are removed together
// after one release, once every device that used the app shows no registration and an empty Cache
// Storage (DevTools > Application) — see docs/todo.md, Wave 0 / S6.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
    })(),
  );
});
