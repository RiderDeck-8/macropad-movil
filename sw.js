// Estrategia: la red manda y la cache es el respaldo, salvo los datos de
// dispositivo (layouts, catalogos) que no cambian y se sirven desde cache.
// Asi la app funciona sin red pero nunca se queda con una version vieja.
const CACHE = 'macropad-v9';
const SHELL = [
  './', './index.html', './styles.css', './icon.svg', './manifest.webmanifest',
  './js/app.js', './js/hid.js', './js/protocol.js', './js/catalog.js',
  './js/macros.js', './js/demo.js',
  './data/devices.json', './data/keycodes.json',
  './data/i18n/es.json', './data/i18n/en.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isStatic = (url) => url.pathname.includes('/data/');

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (isStatic(url)) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetchAndStore(e.request))
    );
    return;
  }
  e.respondWith(
    fetchAndStore(e.request).catch(() =>
      caches.match(e.request).then((hit) => hit || caches.match('./index.html'))
    )
  );
});

function fetchAndStore(request) {
  return fetch(request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
    }
    return res;
  });
}
