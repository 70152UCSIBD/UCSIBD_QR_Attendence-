// next-pwa configuration often expects sw.js to be a copy of service-worker.js
// This file will be populated by next-pwa during build
// For development, it can be a minimal placeholder.
// The actual service worker logic is primarily handled by workbox via next-pwa
self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
