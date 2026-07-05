// PulseDeck Service Worker — 静的アセットの stale-while-revalidate キャッシュ
// キャッシュから即応答しつつ裏で最新を取得するため、デプロイ後は次の起動で新 UI に切り替わる。

const CACHE = "pulsedeck-static-v1";
const ASSETS = [
  "/",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  // 旧バージョンのキャッシュを掃除してから即座に制御を引き継ぐ
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // メトリクス API は常にネットワーク直行（古いデータを見せない）。SSE もここで素通しになる
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) {
    return;
  }
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request);
      const fetched = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached); // オフライン時はキャッシュにフォールバック
      return cached ?? fetched;
    }),
  );
});
