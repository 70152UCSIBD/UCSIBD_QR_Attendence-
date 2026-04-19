// This is a minimal service worker for Next.js PWA setup.
// next-pwa will inject its own logic here during the build process.
self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
