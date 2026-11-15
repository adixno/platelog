// Offline shell: the app's own files are served from cache and refreshed in the
// background; the pinned SDK bundle from the CDN is cached once. Calls to the
// Gemini and Claude APIs are never intercepted.
const CACHE = "platelog-v2";
const SHELL = ["./", "index.html", "styles.css", "app.js", "icon.svg", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin;
  const sdk = url.hostname === "esm.sh";
  if (!own && !sdk) return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      // Versioned SDK files never change, so the cached copy is final.
      if (hit && sdk) return hit;
      return hit || refresh;
    })
  );
});
