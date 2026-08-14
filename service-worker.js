// Marsa — Container Search & Yard Management System
// Simple app-shell cache. Bump CACHE_NAME whenever you change
// index.html / app.js / styles.css so the new version is picked up.
const CACHE_NAME = 'marsa-cache-v1';

const APP_SHELL = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];

// Install: pre-cache the app shell.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: drop old caches from previous versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - Never intercept Firebase/Google API calls (cloud sync must always hit the network).
// - App shell files: network-first, falling back to cache when offline
//   (so a redeploy is picked up immediately when online, and the app
//   still opens when there's no connection).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isThirdParty = url.origin !== self.location.origin;
  if (isThirdParty) return; // let CDN + Firebase requests go straight to the network

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('index.html')))
  );
});
