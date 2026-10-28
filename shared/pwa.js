// Registers the install-to-home-screen service worker. sw.js lives at the site root (not under
// /shared/) specifically so its default scope covers every dashboard path, not just /shared/.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
