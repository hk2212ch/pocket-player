/* ==========================================================================
   Pocket Player — service worker
   --------------------------------------------------------------------------
   Rôle : garder une copie des fichiers de l'application (HTML, CSS, JS,
   manifeste, icônes) pour qu'elle s'ouvre sans connexion.

   Les musiques et vidéos importées ne passent JAMAIS par ici : elles sont
   stockées dans IndexedDB et lues via des URL « blob: » locales, que le
   service worker n'intercepte pas.

   MISE À JOUR : à chaque publication d'une nouvelle version, augmentez
   APP_VERSION ci-dessous. C'est ce changement qui déclenche le
   téléchargement des nouveaux fichiers sur l'iPhone.
   ========================================================================== */

const APP_VERSION = '1.0.0';
const CACHE_PREFIX = 'pocket-player-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${APP_VERSION}`;

// Chemins relatifs à l'emplacement de ce fichier : compatible avec un
// sous-dossier GitHub Pages (https://pseudo.github.io/pocket-player/).
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

const INDEX_URL = new URL('./index.html', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache: 'reload' contourne le cache HTTP pour obtenir la dernière version publiée.
    await cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' })));
    // Première installation : rien à remplacer, on s'active tout de suite.
    // Lors d'une mise à jour, on attend que l'utilisateur la valide dans l'app.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (message.type === 'GET_VERSION' && event.ports[0]) {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // On ne gère que les fichiers de l'application elle-même.
  if (url.origin !== self.location.origin) return;

  // Ouverture d'une page : on sert la copie locale de index.html (fonctionne hors ligne).
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match(INDEX_URL);
      if (cached) return cached;
      try {
        return await fetch(request);
      } catch (error) {
        return new Response('<h1>Pocket Player</h1><p>Hors ligne : ouvrez l\'application une première fois avec Internet.</p>', {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // Autres fichiers : copie locale d'abord, réseau en secours.
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (error) {
      return new Response('', { status: 504, statusText: 'Hors ligne' });
    }
  })());
});
