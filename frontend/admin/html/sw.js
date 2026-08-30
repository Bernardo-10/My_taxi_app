// TaxiGo Admin — service worker MINIMAL, uniquement pour la réception des
// notifications push (FCM) en arrière-plan.
//
// Contrairement à frontend/chauffeur/html/sw.js et frontend/client/html/sw.js,
// celui-ci ne met RIEN en cache et ne gère pas l'événement "fetch" : l'espace
// admin est volontairement non installable en PWA (voir la note dans le
// .htaccess racine, "l'espace admin n'est volontairement pas rendu
// installable — voir plan v4"). Ce choix reste valable ; ce service worker
// existe uniquement parce que la réception FCM en arrière-plan (app/onglet
// fermé) l'exige techniquement — un service worker actif est le seul moyen
// pour le navigateur de réveiller l'app pour une notification.
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");
importScripts("/frontend/js/firebase-config.js");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

firebase.initializeApp(FIREBASE_CONFIG);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "TaxiGo Admin";
  const options = {
    body: payload.notification?.body || "",
    // Pas d'icône 192px dédiée à l'admin pour l'instant (seules
    // admin-32.png/admin-16.png existent) — le navigateur agrandit,
    // rendu dégradé mais fonctionnel. À ajouter si besoin.
    icon: "/admin/icons/admin-32.png",
    badge: "/admin/icons/admin-32.png",
    data: payload.data || {},
  };
  self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.link || "/admin/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("/admin/") && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
