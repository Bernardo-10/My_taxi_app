// TaxiGo — service worker (app client)
//
// Rôle actuel : rendre l'app installable (condition technique exigée par
// Chrome/Android) et fournir un filet de secours minimal hors ligne.
// Sera complété plus tard (chantier notifications) avec un listener "push".
//
// IMPORTANT — mise à jour du code :
// Incrémenter CACHE_NAME (v1 -> v2 -> ...) à chaque déploiement qui modifie
// un des fichiers listés dans APP_SHELL. Le navigateur détecte alors que ce
// fichier a changé, installe la nouvelle version en arrière-plan, supprime
// l'ancien cache (voir "activate" ci-dessous) et active la mise à jour
// immédiatement (skipWaiting + clients.claim) sans attendre que l'utilisateur
// ferme complètement l'app.
const CACHE_NAME = "taxigo-client-shell-v1";

const APP_SHELL = [
  "/client/",
  "/frontend/css/style.css",
  "/frontend/js/confirm-modal.js",
  "/frontend/client/js/client-api.js",
  "/frontend/client/js/client-ui.js",
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

// Réseau en priorité (toujours les données/fichiers les plus frais quand
// l'utilisateur est en ligne) ; le cache ne sert que de secours hors ligne
// pour l'app shell statique. Aucune requête backend/*.php n'est mise en
// cache : les courses, positions, etc. doivent toujours venir du serveur.
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
