// TaxiGo — Enregistrement des notifications push (FCM)
// Partagé entre client et chauffeur, sur le modèle de confirm-modal.js /
// notify-feedback.js déjà en place.
//
// Rôle : demander la permission navigateur, récupérer un token FCM via le
// SDK Firebase, puis l'envoyer au serveur pour stockage
// (push_subscriptions). C'est ENSUITE le service worker (sw.js) qui reçoit
// les notifications, même app fermée/écran verrouillé — ce fichier ne fait
// que l'enregistrement initial, appelé une fois par session.
//
// Appel attendu : initPushNotifications("client") ou
// initPushNotifications("chauffeur"), une fois la session confirmée
// authentifiée (après initUserSession()/vérification current_user.php).

async function initPushNotifications(userType) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return; // navigateur sans support Push (Safari hors PWA installée, etc.)
  }
  if (typeof firebase === "undefined") {
    console.warn("[push] SDK Firebase non chargé (vérifier les balises <script> dans le <head>).");
    return;
  }
  if (typeof FIREBASE_CONFIG === "undefined" || FIREBASE_CONFIG.apiKey === "REMPLACE_MOI") {
    console.warn("[push] frontend/js/firebase-config.js n'est pas encore rempli avec les vraies valeurs.");
    return;
  }

  try {
    // Ne redemande jamais si l'utilisateur a déjà refusé explicitement —
    // éviter de le harceler à chaque chargement de page.
    if (Notification.permission === "denied") return;

    if (Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;
    }

    // Le service worker (PWA) est déjà enregistré ailleurs au chargement de
    // la page — on attend juste qu'il soit prêt, on n'en enregistre pas un
    // second.
    const registration = await navigator.serviceWorker.ready;

    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    const messaging = firebase.messaging();

    const token = await messaging.getToken({
      vapidKey: FCM_VAPID_KEY,
      serviceWorkerRegistration: registration,
    });

    if (!token) {
      console.warn("[push] Aucun token FCM obtenu.");
      return;
    }

    const apiBase = userType === "chauffeur" ? "/backend/chauffeur" : "/backend/client";
    await fetch(`${apiBase}/save_push_subscription.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    // Message reçu pendant que l'onglet a le focus : Firebase ne déclenche
    // PAS onBackgroundMessage() dans ce cas (comportement normal du SDK) --
    // c'est ici qu'il faudrait afficher quelque chose si besoin. Pour
    // l'instant, le son/toast existant (notify-feedback.js), déjà déclenché
    // par le polling, couvre ce cas -- pas de doublon nécessaire.
    messaging.onMessage((payload) => {
      console.log("[push] Message reçu (app au premier plan) :", payload);
    });

  } catch (e) {
    console.error("[push] Échec d'initialisation :", e);
  }
}
