const CLIENT_API_BASE = "/backend";

// Fusion (chantier polling optimisé) : dernière position chauffeur reçue via
// checkRideStatus() (check_ride_status.php renvoie déjà driver_lat/driver_lng,
// plus besoin d'un second endpoint get_driver_location.php pour l'obtenir).
// Alimentée à chaque checkRideStatus() réussi, lue par updateDriverPosition()
// (voir plus bas) pour les appels de "redraw forcé" déclenchés depuis
// client-ui.js après une transition d'état.
let lastKnownDriverPos = { lat: null, lng: null };

// Intervalle adaptatif (chantier polling optimisé, étape "intervalle
// adaptatif") : le délai avant le prochain checkRideStatus() dépend de la
// phase de la course. Relu à chaque cycle dans getRidePollDelay() — un
// changement d'état prend donc effet dès le prochain appel, sans attendre
// la fin d'un cycle plus lent déjà entamé.
const RIDE_POLL_INTERVALS_MS = {
    searching: 2500,   // attente d'acceptation par un chauffeur
    accepted: 4500,    // chauffeur en route vers le point de prise en charge
    arrived: 4500,     // chauffeur arrivé, attend le client
    started: 6500      // course en cours
};
const RIDE_POLL_DEFAULT_INTERVAL_MS = 4500; // repli si rideState absent/inconnu

function getRidePollDelay() {
    const state = (typeof AppState !== "undefined") ? AppState.rideState : null;
    const delay = RIDE_POLL_INTERVALS_MS[state];
    return delay !== undefined ? delay : RIDE_POLL_DEFAULT_INTERVAL_MS;
}

// Libellé "1 passager" / "3 passagers" (le pluriel n'était pas géré : "1 passagers").
function formatPassengers(n) {
    const count = parseInt(n, 10) || 1;
    return `${count} passager${count > 1 ? "s" : ""}`;
}

// ═════════════════════════════════════════════════════════════════════
// PRIX AVANT CONFIRMATION (lot F3a)
//
// Avant ce lot, findRoute() calculait l'itinéraire PUIS créait la course dans
// la foulée : le client ne voyait le prix qu'une fraction de seconde, sans
// pouvoir refuser. Désormais :
//   1. refreshQuote() calcule l'itinéraire dès que départ + destination sont
//      connus (choix d'un lieu, changement de passagers, déplacement > 100 m)
//      et remplit le bloc Distance / Temps / Prix de l'onglet carte ;
//   2. le bouton « Trouver une course » CONFIRME : confirmRide() envoie à
//      backend.php exactement les coordonnées et le prix affichés.
// Le serveur reste l'autorité : il recalcule tout (backend.php) et c'est sa
// réponse qui s'affiche ensuite (voir sendToBackend).
// ═════════════════════════════════════════════════════════════════════

// Doit rester identique à PRICE_PER_KM_FCFA dans backend/common/pricing.php.
const QUOTE_PRICE_PER_KM_FCFA = 75;
// Un déplacement GPS plus petit que ça ne refait PAS le calcul (le GPS "bouge"
// de quelques mètres en permanence même à l'arrêt).
const QUOTE_PICKUP_TOLERANCE_M = 100;

let currentQuote = null;      // { pickup:{lat,lng}, destination:{lat,lng}, distanceKm, durationMin }
let quoteState = "idle";      // 'idle' | 'loading' | 'ready' | 'error'
let quoteSeq = 0;             // numéro de la demande en cours : ignore les réponses périmées
let quoteGpsTimer = null;
let quoteInflightKey = null; // trajet dont le calcul est en cours (évite un 2e appel OSRM identique)
let rideSubmitting = false;   // true pendant l'envoi de la course (anti double clic)
const quoteRouteCache = new Map(); // itinéraires déjà calculés (évite de re-solliciter OSRM)

// Distance à vol d'oiseau entre deux points {lat,lng}, en mètres.
function haversineMeters(a, b) {
    const R = 6371000, rad = (x) => x * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function currentPassengers() {
    return parseInt(document.getElementById("passengers")?.value, 10) || 1;
}

// Même formule que compute_price() côté serveur : distance arrondie à 2
// décimales, puis x 75 x passagers, arrondi. Calcul en centièmes entiers pour
// éviter les erreurs d'arrondi des nombres décimaux.
function computeQuotePrice(distanceKm, passengers) {
    return Math.round(Math.round(distanceKm * 100) * QUOTE_PRICE_PER_KM_FCFA * passengers / 100);
}

function quoteRouteKey(from, to) {
    const r = (n) => n.toFixed(5); // ~1 m
    return `${r(from.lat)},${r(from.lng)}>${r(to.lat)},${r(to.lng)}`;
}

function sameDestination(quote, dest) {
    return !!quote && haversineMeters(quote.destination, dest) <= 1;
}

// Itinéraire OSRM (distance + durée seulement : la géométrie n'était de toute
// façon pas utilisée, overview=false est plus léger et identique au serveur).
// Renvoie { distanceKm, durationMin }, { tooClose:true } ou null en cas d'échec.
async function fetchQuoteRoute(from, to) {
    const key = quoteRouteKey(from, to);
    if (quoteRouteCache.has(key)) return quoteRouteCache.get(key);

    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const response = await fetch(url, { signal: ctrl.signal });
        const data = await response.json();
        const r = data.routes && data.routes[0];
        if (!r) return null;

        const route = {
            distanceKm: Math.round(r.distance / 10) / 100, // = round(m / 1000, 2)
            durationMin: Math.round(r.duration / 60)
        };
        if (route.distanceKm <= 0) return { tooClose: true };

        if (quoteRouteCache.size >= 20) quoteRouteCache.delete(quoteRouteCache.keys().next().value);
        quoteRouteCache.set(key, route);
        return route;
    } catch (error) {
        console.error("Erreur itinéraire :", error);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Remplit le bloc Distance / Temps / Prix. #routeDistance est écrit EN DERNIER :
// c'est lui qu'observe fareObserver (client-ui.js), qui affiche le bloc et
// recopie les valeurs dans le panneau Course.
function renderQuote(fitMap) {
    const q = currentQuote;
    if (!q) return;
    const pax = currentPassengers();
    const price = computeQuotePrice(q.distanceKm, pax);

    if (fitMap && typeof map !== "undefined" && map) {
        map.fitBounds(L.latLngBounds(
            [q.pickup.lat, q.pickup.lng],
            [q.destination.lat, q.destination.lng]
        ), { padding: [40, 40] });
    }
    document.getElementById("routeDuration").textContent = `${q.durationMin} min`;
    document.getElementById("routePrice").textContent = `${price} FCFA (${formatPassengers(pax)})`;
    document.getElementById("routeDistance").textContent = `${q.distanceKm.toFixed(2)} km`;
}

// Cache le bloc. Les textes passent à "-" (ASCII) : fareObserver ignore cette
// valeur, il ne sait que MONTRER le bloc — le masquer est à faire ici.
function hideFare() {
    const strip = document.getElementById("fareStrip");
    if (strip) strip.style.display = "none";
    ["routeDuration", "routePrice", "routeDistance"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = "-";
    });
}

// Oublie le prix (changement d'état de la course, retour à zéro) et invalide
// tout calcul encore en vol.
function clearQuote() {
    quoteSeq++;
    quoteInflightKey = null;
    clearTimeout(quoteGpsTimer);
    currentQuote = null;
    quoteState = "idle";
    hideFare();
    if (typeof updateFindRideBtn === "function") updateFindRideBtn();
}

// (Re)calcule le prix si nécessaire.
//   exactPickup : le départ vient d'être choisi explicitement -> pas de tolérance
//   fromGps     : déclenché par le GPS -> pas de recadrage de la carte, pas de message d'erreur
async function refreshQuote(opts = {}) {
    const { exactPickup = false, fromGps = false } = opts;
    if (typeof AppState !== "undefined" && AppState.rideState !== "idle") return;
    if (!pickupCoords || !destinationCoords) { clearQuote(); return; }

    // Même destination et départ quasi inchangé : on garde l'itinéraire, seul
    // le prix peut avoir changé (passagers).
    const keepDestination = sameDestination(currentQuote, destinationCoords);
    const tolerance = exactPickup ? 1 : QUOTE_PICKUP_TOLERANCE_M;
    if (keepDestination && quoteState === "ready" &&
        haversineMeters(pickupCoords, currentQuote.pickup) <= tolerance) {
        renderQuote(false);
        return;
    }

    const pickup = { lat: pickupCoords.lat, lng: pickupCoords.lng };
    const destination = { lat: destinationCoords.lat, lng: destinationCoords.lng };
    // Même trajet déjà en cours de calcul (ex. passagers changés pendant
    // l'attente) : la réponse affichera le prix avec les passagers du moment.
    const routeKey = quoteRouteKey(pickup, destination);
    if (quoteState === "loading" && quoteInflightKey === routeKey) return;

    const seq = ++quoteSeq;
    quoteInflightKey = routeKey;
    if (!keepDestination) { currentQuote = null; hideFare(); } // jamais l'ancien prix pour un autre trajet
    quoteState = "loading";
    if (typeof updateFindRideBtn === "function") updateFindRideBtn();

    const route = await fetchQuoteRoute(pickup, destination);
    if (seq !== quoteSeq) return;                               // une demande plus récente a pris le relais
    quoteInflightKey = null;
    if (typeof AppState !== "undefined" && AppState.rideState !== "idle") return;

    if (!route || route.tooClose) {
        currentQuote = null;
        hideFare();
        quoteState = "error";
        if (typeof updateFindRideBtn === "function") updateFindRideBtn();
        if (!fromGps && typeof showToast === "function") {
            showToast(route && route.tooClose
                ? "Le départ et la destination sont identiques."
                : "Prix indisponible pour le moment, réessayez.");
        }
        return;
    }

    currentQuote = { pickup, destination, distanceKm: route.distanceKm, durationMin: route.durationMin };
    quoteState = "ready";
    renderQuote(!fromGps);
    if (typeof updateFindRideBtn === "function") updateFindRideBtn();
}

// Appelée à chaque position GPS reçue (client-ui.js, watchUserPosition) :
// recalcule seulement au premier signal GPS (si la destination est déjà
// choisie) ou si le client s'est déplacé de plus de 100 m.
function maybeRequoteFromGps() {
    if (!pickupCoords || !destinationCoords || quoteState === "loading") return;
    const needFirst = !currentQuote && quoteState === "idle";
    const moved = !!currentQuote &&
        haversineMeters(pickupCoords, currentQuote.pickup) > QUOTE_PICKUP_TOLERANCE_M;
    if (!needFirst && !moved) return;

    clearTimeout(quoteGpsTimer);
    quoteGpsTimer = setTimeout(() => refreshQuote({ fromGps: true }), 1500);
}

// Le prix affiché correspond-il encore aux points actuels ?
function quoteIsCurrent() {
    return quoteState === "ready" && !!currentQuote && !!pickupCoords && !!destinationCoords &&
        sameDestination(currentQuote, destinationCoords) &&
        haversineMeters(pickupCoords, currentQuote.pickup) <= QUOTE_PICKUP_TOLERANCE_M;
}

// Clic sur « Trouver une course » = confirmation du prix affiché.
async function confirmRide() {
    if (rideSubmitting || quoteState === "loading") return;

    const pickupText = document.getElementById("pickup").value.trim();
    const destinationText = document.getElementById("destination").value.trim();

    if (!pickupCoords) {
        alert("Veuillez choisir votre position de départ.");
        return;
    }
    if (!destinationCoords || !destinationText) {
        alert("Veuillez entrer une destination.");
        return;
    }

    // Aucun prix valide à l'écran (calcul échoué, ou départ très éloigné) :
    // on le recalcule et on laisse le client le voir avant de confirmer.
    if (!quoteIsCurrent()) {
        await refreshQuote({ exactPickup: true });
        if (quoteState === "ready" && typeof showToast === "function") {
            showToast("Vérifiez le prix, puis appuyez de nouveau pour confirmer.");
        }
        return;
    }

    const q = currentQuote;
    const passengers = currentPassengers();

    // La course part du point utilisé pour le prix (le chauffeur ira là où le
    // prix a été calculé). Le GPS est gelé le temps de l'envoi : sinon une
    // mise à jour de position pourrait réécrire pickupCoords entre-temps.
    const previousLock = AppState.pickupLocked;
    rideSubmitting = true;
    if (typeof updateFindRideBtn === "function") updateFindRideBtn();
    AppState.pickupLocked = true;
    if (haversineMeters(pickupCoords, q.pickup) > 1) {
        pickupCoords = { lat: q.pickup.lat, lng: q.pickup.lng };
        updateMarker("pickup", pickupCoords.lat, pickupCoords.lng);
    }

    let result = null;
    try {
        result = await sendToBackend({
            pickup: pickupText,
            destination: destinationText,
            pickup_lat: q.pickup.lat,
            pickup_lng: q.pickup.lng,
            destination_lat: q.destination.lat,
            destination_lng: q.destination.lng,
            distance_km: q.distanceKm,
            duration_min: q.durationMin,
            price_fcfa: computeQuotePrice(q.distanceKm, passengers),
            passengers: passengers
        });
    } finally {
        AppState.pickupLocked = previousLock;
        rideSubmitting = false;
        if (typeof updateFindRideBtn === "function") updateFindRideBtn();
    }

    // Avant ce lot, un refus du serveur (ex. "Itinéraire introuvable") ne
    // montrait rien au client. 409 = course déjà en cours : déjà géré dans
    // sendToBackend (toast + reprise de course).
    if (result && result.status !== "success" && !result.existing_ride_id &&
        typeof showToast === "function") {
        showToast(result.message || "Impossible de créer la course, réessayez.");
    }
}

async function reverseGeocode(lat, lng) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
        const response = await fetch(url);
        const data = await response.json();
        return data.display_name;
    } catch (error) {
        console.error("Erreur reverse geocoding :", error);
        return null;
    }
}

async function sendToBackend(data) {
    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/backend.php`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (response.status === 401) {
            window.location.href = "/client/login";
            return result;
        }

        if (result.status === "success" && result.ride_id) {
            currentRideId = result.ride_id;

            // Réaffiche avec les valeurs recalculées par le serveur (peuvent différer
            // légèrement de l'estimation locale) avant de lancer le suivi.
            const routeDistance = document.getElementById("routeDistance");
            const routeDuration = document.getElementById("routeDuration");
            const routePrice    = document.getElementById("routePrice");
            if (routeDistance) routeDistance.textContent = `${result.distance_km.toFixed(2)} km`;
            if (routeDuration) routeDuration.textContent = `${result.duration_min} min`;
            if (routePrice)    routePrice.textContent    = `${result.price_fcfa} FCFA (${formatPassengers(data.passengers)})`;

            showWaitingMessage();
            startRideTracking();

            const cancelBtn = document.getElementById("cancelRideBtn");
            if (cancelBtn) {
                cancelBtn.style.display = "block";
                cancelBtn.disabled = false;
            }
        }

        // Une course active existe déjà côté serveur (double onglet, double-clic...) :
        // au lieu de laisser l'échec silencieux, on rebascule sur cette course
        // existante via la même logique que la reprise après rafraîchissement.
        if (response.status === 409 && result.existing_ride_id) {
            if (typeof showToast === "function") {
                showToast("Une course est déjà en cours");
            }
            if (typeof initActiveRideRecovery === "function") {
                await initActiveRideRecovery();
            }
        }

        return result;
    } catch (error) {
        console.error("Erreur backend:", error);
        return { status: "error", message: "Erreur de connexion" };
    }
}

// Appelée une seule fois au chargement de la page (voir initActiveRideRecovery
// dans client-ui.js) pour savoir si une course est toujours en cours côté serveur
// après un rafraîchissement forcé.
async function fetchActiveRide() {
    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/get_active_ride.php`);
        const result = await response.json();

        if (response.status === 401) {
            window.location.href = "/client/login";
            return null;
        }

        if (result.status !== "success" || !result.has_active_ride) {
            return null;
        }

        return result;
    } catch (error) {
        console.error("Erreur récupération course active:", error);
        return null;
    }
}

// ── CHAUFFEURS DISPONIBLES (chantier 3, v4) ────────────────────────
// Appelée en boucle par startNearbyDriversPolling() (client-ui.js) tant que
// AppState.rideState === "idle". Retourne uniquement les chauffeurs
// réellement disponibles (filtré côté serveur, voir nearby_drivers.php) :
// pas de téléphone, pas de chauffeurs en course.
async function fetchNearbyDrivers() {
    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/nearby_drivers.php`);
        const result = await response.json();

        if (result.status !== "success") return [];
        return result.drivers || [];
    } catch (error) {
        console.error("Erreur récupération chauffeurs à proximité:", error);
        return [];
    }
}

function startRideTracking() {
    if (rideStatusCheckInterval) {
        clearTimeout(rideStatusCheckInterval);
        rideStatusCheckInterval = null;
    }

    const cancelBtn = document.getElementById("cancelRideBtn");
    if (cancelBtn) {
        cancelBtn.style.display = "block";
        cancelBtn.disabled = false;
    }

    rideAccepted = false;
    updateRideStatusMessage("En attente d'acceptation du chauffeur...");
    runRideStatusPoll(); // premier appel immédiat, la boucle se replanifie elle-même

    // Fusion (chantier polling optimisé) : plus de driverStatusInterval séparé.
    // checkRideStatus() récupère déjà driver_lat/driver_lng à chaque appel
    // (voir check_ride_status.php) — le rendu du marqueur/tracé chauffeur est
    // désormais déclenché directement depuis checkRideStatus(), sans second
    // fetch réseau vers get_driver_location.php.
}

// Boucle de polling à intervalle adaptatif : remplace l'ancien
// setInterval(checkRideStatus, 5000) fixe par un setTimeout récursif. Le
// délai du prochain appel est recalculé après chaque réponse (getRidePollDelay
// relit AppState.rideState à ce moment précis, voir plus haut).
//
// rideStillActive() (définie plus bas) sert de garde après l'await : c'est le
// même mécanisme déjà utilisé dans checkRideStatus() pour renderDriverOnMap,
// car clearTimeout()/clearInterval() n'annulent pas un appel déjà en vol —
// sans cette garde, un cleanup (onRideCompleted/onRideCancelled) survenu
// pendant l'await pourrait être suivi d'une replanification fantôme.
async function runRideStatusPoll() {
    await checkRideStatus();

    if (!rideStillActive()) return;

    rideStatusCheckInterval = setTimeout(runRideStatusPoll, getRidePollDelay());
}

async function checkRideStatus(forceRefresh = false) {
    if (!currentRideId) return null;

    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/check_ride_status.php?ride_id=${currentRideId}`);
        const result = await response.json();

        if (result.status !== "success") {
            updateRideStatusMessage("Impossible de vérifier le statut de la course.");
            return null;
        }

        const rideData = {
            status: result.ride_status,
            driver: {
                name: result.driver_name || "Votre chauffeur",
                plate: result.driver_plate || "-",
                color: result.driver_color || "",
                rating: result.driver_rating || "4.8",
                phone: result.driver_phone || result.driver_tel || "",
                lat: parseFloat(result.driver_lat),
                lng: parseFloat(result.driver_lng)
            },
            pickup: {
                lat: parseFloat(result.pickup_lat),
                lng: parseFloat(result.pickup_lng)
            },
            destination: {
                lat: parseFloat(result.destination_lat),
                lng: parseFloat(result.destination_lng)
            }
        };

        // Appeler la fonction UI pour mettre à jour l'affichage selon le statut
        if (typeof onRideStatusUpdate === "function") {
            onRideStatusUpdate(rideData);
        }

        // Gestion des transitions
        if (rideData.status === "accepted" && !rideAccepted) {
            rideAccepted = true;
            onRideAccepted(rideData.driver);
        } 
        else if (rideData.status === "arrived") {
            rideAccepted = true;
            if (typeof onRideArrived === "function") onRideArrived(rideData);
        }
        else if (rideData.status === "started") {
            rideAccepted = true;
            // On notifie l'UI que la course a commencé
            if (typeof onRideStarted === "function") onRideStarted(rideData);
        }
        else if (rideData.status === "completed") {
            clearTimeout(rideStatusCheckInterval); rideStatusCheckInterval = null;
            if (typeof onRideCompleted === "function") onRideCompleted();
        }
        else if (rideData.status === "reported") {
            // 'reported' = le chauffeur a signalé un problème en cours de course
            // (backend/chauffeur/report_problem.php). Avant ce correctif, ce
            // statut n'avait aucune branche ici : le polling tournait sans fin
            // et le client restait bloqué sur "Course en cours" (l'annulation
            // renvoyait 409). La course est terminée de son point de vue :
            // on arrête le suivi, on remet l'interface à zéro et on l'informe.
            clearTimeout(rideStatusCheckInterval); rideStatusCheckInterval = null;
            if (typeof onRideReported === "function") onRideReported();
        }
        else if (rideData.status === "cancelled") {
            // Chantier son/vibration (06/07/2026) : "cancelled" est mis par
            // backend/chauffeur/cancel_ride.php — c'est le CHAUFFEUR qui a
            // annulé. Avant ce chantier, ce cas ne montrait strictement rien
            // au client (reset silencieux). Toast + son3 + vibration ajoutés,
            // symétriques au toast "annulé client" déjà côté chauffeur (même
            // son3 réutilisé des deux côtés).
            clearTimeout(rideStatusCheckInterval); rideStatusCheckInterval = null;
            if (typeof onRideCancelled === "function") onRideCancelled();
            if (typeof showToast === "function") {
                showToast("La course a été annulée par le chauffeur.");
            }
            if (typeof window.notifyFeedback === "function") {
                window.notifyFeedback({
                    sound: "cancelled",
                    vibrate: [100, 60, 100, 60, 100],
                    notify: { title: "Course annulée", body: "La course a été annulée par le chauffeur.", tag: "taxigo-ride" }
                });
            }
        }
        else if (rideData.status === "cancelled_client") {
            // "cancelled_client" est normalement déjà géré immédiatement par
            // cancelCurrentRide() (toast + vibration) au moment du clic. Ce
            // cas ne se déclenche ici que si un AUTRE onglet/appareil du même
            // client a annulé entre-temps — cas limite, mais on évite quand
            // même un reset totalement silencieux sur ce second appareil.
            clearTimeout(rideStatusCheckInterval); rideStatusCheckInterval = null;
            if (typeof onRideCancelled === "function") onRideCancelled();
            if (typeof showToast === "function") {
                showToast("Course annulée");
            }
            if (typeof window.notifyFeedback === "function") {
                window.notifyFeedback({ vibrate: [60] });
            }
        }

        // Fusion (chantier polling optimisé) : mémoriser la position reçue et
        // déclencher le rendu du marqueur/tracé chauffeur avec les mêmes
        // données que ci-dessus — remplace l'ancien fetch séparé vers
        // get_driver_location.php (updateDriverPosition() ci-dessous devient
        // un simple wrapper qui réutilise ce cache).
        lastKnownDriverPos = { lat: rideData.driver.lat, lng: rideData.driver.lng };
        if (rideAccepted && rideStillActive()) {
            renderDriverOnMap(rideData.driver.lat, rideData.driver.lng);
        }

        return rideData;
    } catch (error) {
        console.error("Erreur vérification statut de course:", error);
        updateRideStatusMessage("Erreur lors de la vérification du statut.");
        return null;
    }
}

// Vrai tant qu'une course est en cours et n'a pas été nettoyée entre-temps
// (onRideCompleted/onRideCancelled). Sert à re-vérifier après un await, car
// clearInterval() n'annule pas un appel déjà en vol au moment du cleanup.
function rideStillActive() {
    return !!currentRideId && typeof AppState !== "undefined" && AppState.rideState !== "idle";
}

// Fusion (chantier polling optimisé) : wrapper léger, sans fetch. Utilisé par
// client-ui.js (3 points d'appel) pour forcer un redraw immédiat après une
// transition d'état (onRideAccepted/onRideArrived/onRideStarted resettent
// lastDriverLat/lastDriverLng à null juste avant, pour forcer posChanged=true
// dans renderDriverOnMap ci-dessous). Réutilise la dernière position connue —
// déjà reçue par le checkRideStatus() qui vient de déclencher la transition,
// donc aucune donnée manquante malgré l'absence de nouveau fetch ici.
async function updateDriverPosition() {
    if (!currentRideId || !rideAccepted) return;
    if (!rideStillActive()) return;
    if (lastKnownDriverPos.lat === null || lastKnownDriverPos.lng === null) return;
    renderDriverOnMap(lastKnownDriverPos.lat, lastKnownDriverPos.lng);
}

// Rendu du marqueur taxi + tracé de route, à partir d'une position déjà connue
// (plus de fetch ici — voir checkRideStatus() qui appelle cette fonction avec
// les données reçues du même cycle, et updateDriverPosition() ci-dessus qui
// la rappelle avec la dernière position en cache pour les redraws forcés).
async function renderDriverOnMap(driverLat, driverLng) {
    try {
        if (!rideStillActive()) return;

        if (isNaN(driverLat) || isNaN(driverLng)) {
            updateRideStatusMessage("Attente de la position du chauffeur...");
            return;
        }

        // Déclarer state en premier — utilisé à la fois pour le popup et les tracés
        const state = (typeof AppState !== "undefined") ? AppState.rideState : "accepted";

        // Texte du popup selon l'état courant
        const popupTexts = {
            accepted: "Il arrive vers vous !",
            arrived:  "Il est arrivé ✅",
            started:  "Course commencée 🚗"
        };
        const popupMsg = popupTexts[state] || "Il arrive vers vous !";

        // Marqueur taxi — uniquement pour accepted et arrived (en started, le client est dans le taxi)
        if (state !== "started") {
            if (driverPositionMarker) {
                driverPositionMarker.setLatLng([driverLat, driverLng]);
                driverPositionMarker.setPopupContent(`<strong>Votre chauffeur</strong><br>${popupMsg}`);
            } else {
                const taxiIcon = L.divIcon({
                    html: '<div class="driver-marker-dot" aria-label="Chauffeur">🚕</div>',
                    className: "driver-marker-icon",
                    iconSize: [40, 40],
                    iconAnchor: [20, 40],
                    popupAnchor: [0, -40]
                });
                driverPositionMarker = L.marker([driverLat, driverLng], { icon: taxiIcon })
                    .addTo(map)
                    .bindPopup(`<strong>Votre chauffeur</strong><br>${popupMsg}`);
                driverPositionMarker.openPopup();
            }
        }

        const posChanged = (lastDriverLat === null) ||
            (Math.abs(driverLat - lastDriverLat) > 0.00005) ||
            (Math.abs(driverLng - lastDriverLng) > 0.00005);

        lastDriverLat = driverLat;
        lastDriverLng = driverLng;

        if (state === "accepted") {
            // ── Chauffeur → Pickup : ligne bleue pleine (crossfade, sans clignotement)
            if (pickupCoords && posChanged) {
                const route = await getRouteGeoJSON(driverLng, driverLat, pickupCoords.lng, pickupCoords.lat);
                if (route && rideStillActive()) {
                    if (typeof updateDriverETA === "function") updateDriverETA(route.distance, route.duration);
                    const newLayer = L.geoJSON(route.geometry, {
                        style: { color: "#3b82f6", weight: 5, opacity: 0.9, dashArray: null }
                    }).addTo(map);
                    if (driverRouteLayer) map.removeLayer(driverRouteLayer);
                    driverRouteLayer = newLayer;
                }
            }

        } else if (state === "arrived") {
            // ── Chauffeur → Client : vraie route OSRM en pointillés gris
            // On trace si la position a changé OU si le tracé n'existe pas encore
            if (pickupCoords && (posChanged || !driverRouteLayer)) {
                const route = await getRouteGeoJSON(driverLng, driverLat, pickupCoords.lng, pickupCoords.lat);
                if (route && rideStillActive()) {
                    const newLayer = L.geoJSON(route.geometry, {
                        style: { color: "#9ca3af", weight: 4, opacity: 0.85, dashArray: "8, 10" }
                    }).addTo(map);
                    if (driverRouteLayer) map.removeLayer(driverRouteLayer);
                    driverRouteLayer = newLayer;
                }
            }

        } else if (state === "started") {
            // ── Client (pickup) → Destination : ligne verte pleine
            // pickupCoords est mis à jour en temps réel par watchUserPosition
            // On force le tracé à chaque appel si le tracé n'existe pas encore
            if (destinationCoords && pickupCoords && !driverRouteLayer) {
                const route = await getRouteGeoJSON(pickupCoords.lng, pickupCoords.lat, destinationCoords.lng, destinationCoords.lat);
                if (route && rideStillActive()) {
                    const newLayer = L.geoJSON(route.geometry, {
                        style: { color: "#1db954", weight: 5, opacity: 0.9, dashArray: null }
                    }).addTo(map);
                    if (driverRouteLayer) map.removeLayer(driverRouteLayer);
                    driverRouteLayer = newLayer;
                }
            } else if (destinationCoords && pickupCoords && posChanged) {
                // Recalcul si le chauffeur (et donc le client) a bougé significativement
                const route = await getRouteGeoJSON(pickupCoords.lng, pickupCoords.lat, destinationCoords.lng, destinationCoords.lat);
                if (route && rideStillActive()) {
                    const newLayer = L.geoJSON(route.geometry, {
                        style: { color: "#1db954", weight: 5, opacity: 0.9, dashArray: null }
                    }).addTo(map);
                    if (driverRouteLayer) map.removeLayer(driverRouteLayer);
                    driverRouteLayer = newLayer;
                }
            }
        }

    } catch (error) {
        console.error("Erreur mise à jour position chauffeur:", error);
    }
}

async function getRouteGeoJSON(startLng, startLat, endLng, endLat) {
    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
        const response = await fetch(url);
        const data = await response.json();
        return data.routes && data.routes[0] ? data.routes[0] : null;
    } catch (error) {
        console.error("Erreur OSRM route:", error);
        return null;
    }
}

async function loadUserRides() {
    try {
        const response = await fetch(`${CLIENT_API_BASE}/client/get_user_rides.php`);

        if (response.status === 401) {
            window.location.href = "/client/login";
            return;
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const text = await response.text();
        userRides = JSON.parse(text);

        if (!Array.isArray(userRides)) {
            throw new Error(`Réponse inattendue du serveur : ${JSON.stringify(userRides)}`);
        }

        displayRides();
    } catch (error) {
        console.error("Erreur chargement courses:", error);
        ridesContainer.innerHTML = "<p>Erreur lors du chargement des courses.</p>";
    }
}

async function drawRouteOnMap(fromCoords, toCoords) {
    if (!fromCoords || !toCoords) return;

    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${fromCoords.lng},${fromCoords.lat};${toCoords.lng},${toCoords.lat}?overview=full&geometries=geojson`;
        const response = await fetch(url);
        const data = await response.json();

        if (!data.routes || !data.routes.length) return;

        const route = data.routes[0];
        if (routeLayer) {
            map.removeLayer(routeLayer);
        }

        routeLayer = L.geoJSON(route.geometry, {
            style: {
                color: "#27ae60",
                weight: 6,
                opacity: 0.8
            }
        }).addTo(map);
    } catch (error) {
        console.error("Erreur affichage itinéraire historique:", error);
    }
}