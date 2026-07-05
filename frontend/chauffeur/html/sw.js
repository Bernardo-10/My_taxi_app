// TaxiGo Driver — service worker (app chauffeur)
//
// Même rôle et même logique de mise à jour que la version client
// (voir les commentaires dans frontend/client/html/sw.js) : incrémenter
// CACHE_NAME à chaque déploiement qui touche un fichier de APP_SHELL.
const CACHE_NAME = "taxigo-chauffeur-shell-v2";

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

// Réseau réellement forcé à chaque requête -- pas seulement "en priorité".
// { cache: "no-store" } fait sortir la requête du cache HTTP du navigateur,
// pas seulement du cache de ce service worker : sans ça, `fetch(event.request)`
// peut être satisfait par le cache HTTP standard sans jamais toucher le
// serveur, même dans un schéma "réseau d'abord". C'était la cause du bug où
// une session expirée restait "vue" comme valide malgré rafraîchissements
// répétés. Le cache (APP_SHELL) ne sert plus QUE de filet de secours si la
// requête réseau échoue réellement (vraiment hors ligne) -- il n'est jamais
// consulté en premier.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request.url, { cache: "no-store" })
      .then((response) => response)
      .catch(() => caches.match(event.request))
  );
});