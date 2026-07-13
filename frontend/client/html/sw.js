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
const CACHE_NAME = "taxigo-client-shell-v2";

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

// Réseau réellement forcé à chaque requête (pas seulement "en priorité") :
// { cache: "no-store" } fait sortir la requête du cache HTTP du navigateur,
// pas seulement du cache de ce service worker. Sans ce paramètre,
// `fetch(event.request)` peut être satisfait par le cache HTTP standard sans
// jamais recontacter le serveur, même dans un schéma "réseau d'abord" -- ce
// qui expliquait des sessions expirées encore vues comme valides malgré des
// rafraîchissements répétés. Le cache (APP_SHELL) ne sert plus QUE de filet
// de secours si la requête réseau échoue réellement (vraiment hors ligne).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request.url, { cache: "no-store" })
      .then((response) => {
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ---------------------------------------------------------------
// Notifications push (FCM) — chantier "notifications", étape 2.
// C'est ce bloc, et lui seul, qui permet de recevoir une notification
// même app fermée / écran verrouillé : le navigateur réveille CE service
// worker (pas la page) quand un push arrive, indépendamment de l'état de
// l'onglet.
// ---------------------------------------------------------------
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");
importScripts("/frontend/js/firebase-config.js");

firebase.initializeApp(FIREBASE_CONFIG);
const messaging = firebase.messaging();

// Déclenché uniquement quand la page n'a pas le focus (app fermée, autre
// onglet actif, écran verrouillé) — c'est le cas qui nous intéresse ici.
// Quand la page EST au premier plan, c'est onMessage() côté client-ui.js
// qui prend le relais (pas ce fichier) pour éviter une notification
// système redondante avec ce qui est déjà visible à l'écran.
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "TaxiGo";
  const options = {
    body: payload.notification?.body || "",
    icon: "/client/icons/client-192.png",
    badge: "/client/icons/client-192.png",
    data: payload.data || {},
  };
  self.registration.showNotification(title, options);
});

// Au clic sur la notification : ramène l'app au premier plan si un onglet
// est déjà ouvert, sinon en ouvre un nouveau sur la page pertinente.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.link || "/client/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("/client/") && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});