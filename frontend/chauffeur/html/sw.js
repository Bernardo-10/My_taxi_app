// TaxiGo Driver — service worker (app chauffeur)
//
// Même rôle et même logique de mise à jour que la version client
// (voir les commentaires dans frontend/client/html/sw.js) : incrémenter
// CACHE_NAME à chaque déploiement qui touche un fichier de APP_SHELL.
const CACHE_NAME = "taxigo-chauffeur-shell-v1";

const APP_SHELL = [
  "/chauffeur/",
  "/frontend/css/chauffeur.css",
  "/frontend/js/confirm-modal.js",
  "/frontend/chauffeur/js/chauffeur-api.js",
  "/frontend/chauffeur/js/chauffeur-ui.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
