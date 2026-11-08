// Service worker: tiene in cache l'app e le librerie, così si apre anche senza rete.
// I dati non passano da qui: li gestisce la cache offline di Firestore.
const VERSION = 'dispensa-v4';
const SHELL = ['./', './index.html', './styles.css', './app.js', './firebase.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const CDN = /^https:\/\/(www\.gstatic\.com\/firebasejs|cdn\.jsdelivr\.net\/npm|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Librerie e font: dalla cache, scaricati una volta sola
  if (CDN.test(req.url)) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // File dell'app: prima la rete (per avere gli aggiornamenti), se manca usa la cache
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) caches.open(VERSION).then(c => c.put(req, res.clone()));
      return res;
    }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || caches.match('./index.html')));
  }
  // Tutto il resto (Firestore, accesso Google, Open Food Facts) passa direttamente
});
