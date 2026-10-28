// Exists only so Chrome/Android treats this site as an installable PWA. Dashboard data is always
// live/polled, so nothing is cached here — every request just passes straight through to the
// network, same as if there were no service worker at all.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', () => {});
