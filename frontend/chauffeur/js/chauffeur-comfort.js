/**
 * chauffeur-comfort.js — TaxiGo Chauffeur — LOT 5 (GPS et confort au volant)
 *
 * Ce fichier regroupe quatre petites choses, pour ne pas alourdir
 * chauffeur-api.js et chauffeur-ui.js :
 *   1. Écran toujours allumé tant que le chauffeur est en ligne (Wake Lock)
 *   2. Bandeau en haut de l'écran : "Hors connexion" / problème GPS
 *   3. Santé du GPS : position périmée, permission refusée
 *   4. Messages d'erreur réseau distincts (hors connexion / serveur / autre)
 *
 * Il doit être chargé AVANT chauffeur-api.js (voir index.html).
 * Il ne dépend d'aucune autre fonction au chargement : tout ce qu'il utilise
 * (isOnline, onGpsPosition) n'est lu qu'au moment où une fonction s'exécute.
 */
"use strict";

/* ═══════════════════════════════════════════════
   1. WAKE LOCK — garde l'écran allumé quand on est en ligne
   Limite connue : le Wake Lock empêche seulement la mise en veille
   AUTOMATIQUE. Si le chauffeur verrouille l'écran ou change d'application,
   le navigateur suspend quand même le JavaScript (donc le GPS).
═══════════════════════════════════════════════ */
let wakeLockSentinel = null;     // verrou actif (ou null)
let wakeLockPending  = false;    // une demande est déjà en cours

/**
 * Aligne le verrou sur l'état : actif si (en ligne ET page visible),
 * sinon libéré. Peut être rappelée autant de fois qu'on veut.
 */
async function syncWakeLock() {
    if (!("wakeLock" in navigator)) return;      // navigateur trop ancien : on ignore

    const wanted = typeof isOnline !== "undefined" && isOnline && !document.hidden;

    if (wanted && !wakeLockSentinel && !wakeLockPending) {
        wakeLockPending = true;
        try {
            wakeLockSentinel = await navigator.wakeLock.request("screen");
            // Le navigateur libère le verrou tout seul (page cachée, batterie faible...)
            wakeLockSentinel.addEventListener("release", () => { wakeLockSentinel = null; });
        } catch (e) {
            wakeLockSentinel = null;                 // refusé (économie d'énergie...) : sans gravité
        } finally {
            wakeLockPending = false;
        }
    } else if (!wanted && wakeLockSentinel) {
        const lock = wakeLockSentinel;
        wakeLockSentinel = null;
        try { await lock.release(); } catch (e) { /* déjà libéré */ }
    }
}

// Le verrou saute quand la page est cachée : on le reprend au retour.
document.addEventListener("visibilitychange", syncWakeLock);

/* ═══════════════════════════════════════════════
   2. BANDEAU D'ÉTAT (hors connexion / GPS)
   Priorité d'affichage : hors connexion > permission GPS > GPS ancien.
═══════════════════════════════════════════════ */
const connState = {
    offline   : typeof navigator !== "undefined" && navigator.onLine === false,
    gpsDenied : false,
    gpsStale  : false,
    staleText : "GPS ancien",
};

function renderConnBanner() {
    const banner = document.getElementById("connBanner");
    if (!banner) return;                          // page pas encore chargée

    let text = "";
    let kind = "";
    if (connState.offline) {
        text = "Hors connexion : les courses ne se mettent plus à jour";
        kind = "offline";
    } else if (connState.gpsDenied) {
        text = "Localisation refusée : activez-la dans les réglages du navigateur";
        kind = "gps";
    } else if (connState.gpsStale) {
        text = connState.staleText;
        kind = "gps";
    }

    banner.textContent = text;                    // textContent : jamais de HTML injecté
    banner.hidden = !text;
    banner.dataset.kind = kind;
    document.getElementById("app")?.classList.toggle("conn-banner-on", !!text);
}

window.addEventListener("offline", () => { connState.offline = true;  renderConnBanner(); });
window.addEventListener("online",  () => {
    connState.offline = false;
    renderConnBanner();
    // Réseau revenu : on relance un cycle tout de suite (fonction de chauffeur-ui.js)
    if (typeof isOnline !== "undefined" && isOnline && typeof schedulePoll === "function") {
        if (typeof pollTimeout !== "undefined" && pollTimeout) clearTimeout(pollTimeout);
        schedulePoll();
    }
});
document.addEventListener("DOMContentLoaded", renderConnBanner);

/* ═══════════════════════════════════════════════
   3. SANTÉ DU GPS
═══════════════════════════════════════════════ */
const GPS_WARN_MS  = 30000;   // au-delà : avertissement "signal faible"
const GPS_STALE_MS = 60000;   // au-delà : on n'envoie plus la position

/** Affiche / efface l'avertissement "GPS ancien". */
function setGpsStale(stale, text) {
    connState.gpsStale = !!stale;
    if (text) connState.staleText = text;
    renderConnBanner();
}

/** Un fix GPS valide vient d'arriver : tout redevient normal. */
function onGpsFixReceived() {
    if (!connState.gpsDenied && !connState.gpsStale) return;
    connState.gpsDenied = false;
    connState.gpsStale  = false;
    renderConnBanner();
}

/** Callback d'erreur de watchPosition (branché dans initMap, chauffeur-ui.js). */
function onGpsWatchError(err) {
    console.warn("GPS watch error:", err.message);
    if (err.code === 1) {                         // PERMISSION_DENIED
        connState.gpsDenied = true;
        renderConnBanner();
    }
    // code 2 (position indisponible) / 3 (délai) : le contrôle d'âge de
    // updateDriverPosition() affichera "GPS ancien" si ça dure.
}

/**
 * Demande UNE position fraîche au GPS (8 s max). Sert quand le suivi continu
 * semble silencieux : à l'arrêt, certains téléphones n'émettent plus rien.
 * Succès → onGpsPosition() met à jour le cache ET le marqueur.
 */
function tryRefreshGps() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) { resolve(false); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => { onGpsPosition(pos); resolve(true); },
            (err) => { onGpsWatchError(err); resolve(false); },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
    });
}

/* ═══════════════════════════════════════════════
   4. MESSAGES D'ERREUR RÉSEAU
═══════════════════════════════════════════════ */
/**
 * Choisit le bon message pour un toast d'erreur.
 *  - erreur serveur (5xx) levée par driverFetch → son message
 *  - échec réseau du navigateur (TypeError)     → "Hors connexion" ou message générique
 *  - autre erreur avec un message en français   → ce message
 */
function networkErrorMessage(err, fallback = "Erreur de connexion") {
    if (err && err.isServerError) return err.message;
    if (err instanceof TypeError) {               // fetch() qui n'a pas pu joindre le serveur
        return navigator.onLine === false
            ? "Hors connexion : vérifiez votre réseau"
            : fallback;
    }
    if (err instanceof SyntaxError) return fallback;   // réponse non JSON : message technique inutile
    return (err && err.message) ? err.message : fallback;
}
