/**
 * chauffeur-ui.js — TaxiGo Interface Chauffeur
 *
 * CHANTIER SUIVI DE LA CARTE (recentrage) :
 *
 *  ✅ La carte ne revient plus de force sur le chauffeur dès qu'on la déplace.
 *     CAUSE  : le garde-fou userMovedMap s'appuyait sur "movestart" + e.originalEvent,
 *              or cet évènement Leaflet n'expose pas originalEvent : le drapeau ne
 *              passait jamais à true et chaque position GPS recentrait la carte.
 *     FIX    : "dragstart" (déplacement au doigt/souris) et "zoomstart" (pincement,
 *              boutons + / −) coupent le suivi ; les déplacements décidés par le code
 *              passent par moveMapProgrammatically() et sont ignorés.
 *  ✅ Bouton "Recentrer" sous les boutons + / − (à droite de la carte) : réactive le
 *     suivi et recentre sur le chauffeur. Bleu = suivi actif, orange = suivi coupé.
 *
 * CHANTIER ITINÉRAIRE UNIQUE (refonte de la carte chauffeur) :
 *
 *  ✅ Un SEUL tracé pour toutes les courses actives (au lieu de 2 tracés par
 *     course : vers le client puis vers la destination). Le meilleur ordre de
 *     passage (distance totale la plus courte) est calculé par route-planner.js
 *     (2 requêtes OSRM par calcul quel que soit le nombre de courses).
 *  ✅ Deux familles de panneaux : "À récupérer" (orange) et "Fin de course"
 *     (vert), numérotés dans l'ordre de passage ; bandeau "Prochain arrêt".
 *  ✅ Décharge immédiate : les repères d'une course terminée/annulée/démarrée
 *     sont retirés de façon synchrone (état local), sans attendre le réseau ;
 *     la partie déjà parcourue du tracé est rognée localement ; un résultat de
 *     calcul périmé est jeté (plus de tracé fantôme).
 *  ✅ Recalcul uniquement sur événement (course acceptée/annulée/démarrée/
 *     arrivée/terminée) ou si le chauffeur s'écarte du tracé (plus de recalcul
 *     "toutes les 100 m"). Corrige aussi le cache de tracés qui était vidé à
 *     chaque cycle (clés texte vs identifiants numériques).
 *  ✅ Supprimé : calculateRoute(), routeCache, routeLayers, rideMarkers,
 *     destinationMarkers, destinationMap, isUpdatingRoutes, marqueur rouge
 *     chargé depuis raw.githubusercontent.com.
 *
 * CORRECTIONS CETTE SESSION :
 *
 *  ✅ BUG #1 — Poll concurrent lors du toggle statut
 *     CAUSE  : schedulePoll() tournait même hors ligne toutes les 5s.
 *              Au retour en ligne, initStatusToggle() déclenchait checkNewRides()
 *              manuellement EN MÊME TEMPS que le poll récursif → 2 appels
 *              concurrents → renderPendingRides() x2 → DOM recréé pendant
 *              le clic sur "Accepter" → bouton détaché, acceptRide() échoue.
 *     FIX    : schedulePoll() sort immédiatement si !isOnline (pas de fetch,
 *              pas de render). Le toggle passe isOnline=true AVANT de lancer
 *              checkNewRides(), et schedulePoll() reprend naturellement au
 *              prochain cycle sans appel doublon.
 *
 *  ✅ BUG #6 — routeCache jamais purgé après désactivation du statut
 *     CAUSE  : En passant hors ligne, allRides est toujours peuplé mais
 *              renderPendingRides/renderActiveCourses ne sont plus appelés.
 *              Au retour en ligne, updateRideMarkers() compare le cache
 *              avec des courses désormais obsolètes → routes fantômes sur
 *              la carte, markers orphelins.
 *     FIX    : onStatusChange(false) vide allRides et purge les marqueurs
 *              et le routeCache explicitement.
 *
 *  ✅ BUG #7 — isCheckingRides jamais remis à false si checkNewRides() throw
 *     CAUSE  : Si le fetch dans checkNewRides() lève une exception réseau,
 *              isCheckingRides reste true → schedulePoll() ne relance jamais
 *              un vrai poll → les courses ne se chargent plus après une
 *              coupure réseau temporaire.
 *     FIX    : isCheckingRides est géré dans schedulePoll() via try/finally,
 *              PAS dans checkNewRides(). checkNewRides() est maintenant pur :
 *              il fetch, met à jour allRides et render. Toute exception
 *              remonte à schedulePoll() qui remet le flag à false dans finally.
 *
 *  ✅ CHANTIER 2 — Alertes plein écran qui réapparaissent au rafraîchissement
 *     CAUSE  : shownClientReports/shownCancellations étaient de simples
 *              Set() en mémoire, réinitialisés à chaque chargement de page.
 *     FIX    : persistance dans localStorage (loadShownAlerts/persistShownAlerts/
 *              markAlertShown), fenêtre de rétention 24h alignée sur la fenêtre
 *              serveur de get_rides.php pour cancelled_client.
 *
 *  ✅ CHANTIER 4 (v3) — Alerte "problème client" retirée du chauffeur
 *     CAUSE  : afficher au chauffeur lui-même l'alerte "cette course est
 *              surveillée" est contre-productif d'un point de vue sécurité —
 *              ça prévient la personne surveillée qu'elle l'est.
 *     FIX    : showClientProblemAlerts()/openClientProblemAlert() supprimées.
 *              L'alerte vit désormais côté admin (frontend/admin/js/admin-ui.js),
 *              avec un dédup serveur (rides.client_problem_resolved_at) plutôt
 *              que localStorage, pour rester cohérent entre plusieurs postes admin.
 *              get_rides.php ne renvoie plus client_problem_description/
 *              client_problem_at au chauffeur (whitelist de colonnes).
 */

/* ═══════════════════════════════════════════════
   ÉTAT GLOBAL
═══════════════════════════════════════════════ */
function getDashboardCacheKey() {
  // Sépare le cache par chauffeur pour éviter les fuites entre comptes
  const id = (window.currentDriverId !== undefined && window.currentDriverId !== null)
    ? String(window.currentDriverId)
    : "anon";
  return `taxigo_driver_dashboard_history_${id}`;
}

function loadDashboardCache() {
  try {
    const raw = localStorage.getItem(getDashboardCacheKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function persistDashboardCache(rides) {
  try {
    localStorage.setItem(getDashboardCacheKey(), JSON.stringify(Array.isArray(rides) ? rides : []));
  } catch (e) {
    // stockage local indisponible : l'état live reste en mémoire, le cache
    // n'est alors qu'un meilleur-effort pour la reprise hors ligne.
  }
}

function hydrateDashboardFromCache() {
  if (Array.isArray(dashboardHistory) && dashboardHistory.length > 0) return;
  const cached = loadDashboardCache();
  if (cached.length > 0) dashboardHistory = cached;
}

let map;
let driverMarker        = null;
let allRides            = [];
let dashboardHistory    = loadDashboardCache();

// Itinéraire unique (voir section "MAP — ITINÉRAIRE UNIQUE")
const ROUTE_DEVIATION_M     = 70;      // écart max au tracé avant de parler de déviation
const ROUTE_DEVIATION_HOLD  = 5000;    // durée (ms) d'écart continu avant recalcul
const ROUTE_RECALC_COOLDOWN = 15000;   // délai mini (ms) entre deux recalculs sur déviation
const ROUTE_TRIM_THROTTLE   = 1000;    // rognage du tracé au plus 1 fois / seconde
const ROUTE_MAX_ACCURACY_M  = 60;      // GPS plus imprécis : on ne conclut pas à une déviation
const ROUTE_VEHICLE_CAPACITY = 5;      // passagers max à bord (aligné sur client/backend.php)
const LOCAL_STATUS_TTL_MS   = 10000;   // validité d'un statut appliqué localement avant confirmation serveur

const localRideStatus   = new Map();   // id -> { status, ts } : effet immédiat des actions du chauffeur
const stopMarkers       = new Map();   // coordKey -> L.marker (un panneau par point, arrêts fusionnés)
let routeCasing         = null;        // contour blanc du tracé
let routeMain           = null;        // tracé principal
let routePlan           = null;        // dernier plan appliqué (voir RoutePlanner.computePlan)
let currentStops        = [];          // arrêts attendus d'après l'état local (synchrone)
let currentSignature    = "";
let computingSignature  = "";
let routeSeq            = 0;           // numéro du calcul valide (dernier gagnant)
let routeBusy           = false;
let routeDirty          = false;
let routeAbort          = null;
let offRouteSince       = null;
let lastRecalcAt        = 0;
let lastTrimAt          = 0;
let routeBanner         = null;

// Flags concurrence
let isCheckingRides     = false;

// GPS
let gpsWatchId          = null;
let userMovedMap        = false;   // true = suivi du chauffeur coupé (l'utilisateur a pris la main)
let programmaticMove    = false;   // true pendant un setView décidé par le code (à ignorer)
let recenterBtnEl       = null;
let initialGpsDone      = false;

// Polling
let pollTimeout         = null;
let positionTimeout     = null;

// Tab / filter state
let activeTab           = "map";
let activeFilter        = "accepted";

// Report modal state
let reportRideId        = null;

// Persistance des alertes plein écran déjà vues (problème client, annulation
// client) dans localStorage, pour survivre à un rafraîchissement de page —
// même pattern que "taxigo_recents" côté client. Fenêtre de rétention de 24h,
// alignée sur la fenêtre serveur de get_rides.php pour cancelled_client.
const CANCELLATIONS_STORAGE_KEY  = "taxigo_shown_cancellations";
const SHOWN_ALERTS_MAX_AGE_MS    = 24 * 60 * 60 * 1000; // 24h

function loadShownAlerts(storageKey) {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(storageKey) || "{}"); }
    catch (e) { raw = {}; }

    const now = Date.now();
    const map = new Map();
    Object.entries(raw).forEach(([key, ts]) => {
        if (typeof ts === "number" && now - ts < SHOWN_ALERTS_MAX_AGE_MS) map.set(key, ts);
    });

    persistShownAlerts(storageKey, map); // purge les entrées expirées dès le chargement
    return map;
}

function persistShownAlerts(storageKey, map) {
    try {
        const obj = {};
        map.forEach((ts, key) => { obj[key] = ts; });
        localStorage.setItem(storageKey, JSON.stringify(obj));
    } catch (e) {
        // localStorage indisponible/plein : l'alerte reste dédupliquée pour
        // la session en cours, seule la persistance au refresh est perdue
    }
}

function markAlertShown(map, storageKey, key) {
    map.set(key, Date.now());
    persistShownAlerts(storageKey, map);
}

// Alerte annulation client (course déjà acceptée/arrivée/démarrée)
let shownCancellations  = loadShownAlerts(CANCELLATIONS_STORAGE_KEY);

// Statut en ligne
let isOnline            = false;
let isDisabled           = false;

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", async () => {
    // On attend la confirmation de session AVANT d'initialiser quoi que ce
    // soit d'interactif (carte, toggle "en ligne", polling...). Auparavant
    // ces initialisations démarraient en parallèle de la vérification de
    // session : un chauffeur non connecté pouvait taper sur "Se mettre en
    // ligne" pendant cette fenêtre et voir une erreur générique au lieu
    // d'être simplement redirigé vers le login.
    const authenticated = await initUserHeader("/chauffeur/login");
    if (!authenticated) return; // redirection déjà lancée par initUserHeader()

    // Notifications push (FCM) — ne bloque jamais le reste de l'app si ça
    // échoue (permission refusée, SDK absent...), voir push-notifications.js.
    initPushNotifications("chauffeur");

    initMap();
    initNavigation();
    initSheetDrag();
    initStatusToggle();
    initRefreshFab();
    initProfileDrawer();
    initReportModal();
    initFilterPills();
    initWallet();
    initDateFilter();
    initDocuments();

    const dateEl = document.getElementById("dashboardDate");
    if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString("fr-FR", {
            weekday: "long", day: "numeric", month: "long"
        });
    }

    schedulePoll();
    schedulePositionUpdate();

    window.addEventListener("beforeunload", cleanup);
});

function cleanup() {
    if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
    if (pollTimeout)     clearTimeout(pollTimeout);
    if (positionTimeout) clearTimeout(positionTimeout);
}

/* ═══════════════════════════════════════════════
   POLLING RÉCURSIF
   BUG #1 FIX : sort immédiatement si hors ligne.
   BUG #7 FIX : isCheckingRides géré ici via try/finally,
                pas dans checkNewRides().
═══════════════════════════════════════════════ */
async function schedulePoll() {
    // BUG #1 FIX : ne pas fetcher quand hors ligne
    if (!isOnline) {
        pollTimeout = setTimeout(schedulePoll, 5000);
        return;
    }

    // BUG #7 FIX : si un fetch est déjà en cours, on attend le prochain cycle
    if (isCheckingRides) {
        pollTimeout = setTimeout(schedulePoll, 5000);
        return;
    }

    isCheckingRides = true;
    try {
        await refreshDriverStatus();
        if (!isDisabled) {
            await checkNewRides();
        }
    } catch (err) {
        // Erreur réseau silencieuse — log seulement
        console.warn("Poll error (temporary):", err?.message);
    } finally {
        // BUG #7 FIX : always reset, même si checkNewRides() throw
        isCheckingRides = false;
        pollTimeout = setTimeout(schedulePoll, 5000);
    }
}

async function schedulePositionUpdate() {
    await updateDriverPosition();
    positionTimeout = setTimeout(schedulePositionUpdate, 10000);
}

async function refreshDriverStatus() {
  try {
    const res = await fetch(`${DRIVER_API_BASE}/common/current_user.php`, { cache: "no-store" });
    if (res.status === 401) {
      window.location.href = "/chauffeur/login";
      return;
    }

    const result = await res.json();
    if (result.status !== "success" || !result.user) return;

    const serverStatus = result.user.status;
    const serverOnline = result.user.is_online ? true : false;
    const previouslyDisabled = isDisabled;

    if (serverStatus !== "active") {
      isDisabled = true;
      if (isOnline) {
        isOnline = false;
        onGoOffline();
      }
      const btn = document.getElementById("statusToggle");
      if (btn) btn.disabled = true;
      const label = document.getElementById("statusLabel");
      const profileStatus = document.getElementById("profileRowStatus");
      if (label) label.textContent = "Compte désactivé";
      if (profileStatus) profileStatus.textContent = "Compte désactivé";
      if (!previouslyDisabled) {
        showToast("Votre compte a été désactivé par l'administrateur. Contactez l'admin.", "error", 5000);
      }
      return;
    }

    if (isDisabled) {
      isDisabled = false;
      const btn = document.getElementById("statusToggle");
      if (btn) btn.disabled = false;
    }

    // Si l'admin a forcé la mise hors ligne (ou correctif §4.1/§4.2 :
    // document expiré, ou position GPS restée silencieuse 10+ min)
    if (!serverOnline && isOnline) {
      isOnline = false;
      onGoOffline();
      const btn = document.getElementById("statusToggle");
      if (btn) btn.classList.remove("online");
      const label = document.getElementById("statusLabel");
      const profileStatus = document.getElementById("profileRowStatus");
      if (label) label.textContent = "Hors ligne";
      if (profileStatus) profileStatus.textContent = "Hors ligne";

      // Correctif §4.3 : le message était auparavant toujours
      // "changé par l'administrateur", même quand la vraie cause
      // était une position GPS restée silencieuse ou un document
      // expiré — les deux autres cas rendus possibles par les
      // correctifs §4.1/§4.2. On adapte le texte à la cause réelle.
      const reason = result.user.offline_reason;
      if (reason === "kyc_expired") {
        const docs = (result.user.expired_documents || []).join(", ") || "Un document";
        showToast(`${docs} expiré(s). Renouvelez-le(s) dans "Mes documents" pour continuer à recevoir des courses.`, "error", 6000);
      } else if (reason === "stale_position") {
        showToast("Votre position GPS n'a pas été reçue depuis un moment — vous avez été repassé hors ligne.", "info", 4000);
      } else {
        showToast("Votre statut a été changé hors ligne par l'administrateur.", "info", 4000);
      }
    }

    // Badge discret "Mes documents" — mis à jour ici gratuitement à
    // chaque appel de current_user.php (chargement de page + chaque
    // tick du polling tant qu'en ligne), sans requête réseau dédiée.
    if (result.user.kyc_alert) {
      updateDocumentsAlertDot(result.user.kyc_alert);
    }
  } catch (error) {
    console.warn("refreshDriverStatus error:", error);
  }
}

/* ═══════════════════════════════════════════════
   MAP
═══════════════════════════════════════════════ */
function initMap() {
    map = L.map("map", { zoomControl: false }).setView([4.05, 9.76], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    L.control.zoom({ position: "topright" }).addTo(map);
    initRecenterControl();           // ajouté après le zoom : s'affiche juste en dessous

    // L'utilisateur prend la main sur la carte : on arrête de la recentrer.
    map.on("dragstart", () => setFollowMode(false));
    map.on("zoomstart", () => { if (!programmaticMove) setFollowMode(false); });

    if (!navigator.geolocation) {
        showToast("La géolocalisation n'est pas disponible", "error");
        return;
    }

    gpsWatchId = navigator.geolocation.watchPosition(
        onGpsPosition,
        (err) => console.warn("GPS watch error:", err.message),
        { enableHighAccuracy: true, maximumAge: 0 }
    );
}

/* ── Suivi du chauffeur / bouton "Recentrer" ─── */

const RECENTER_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>' +
    '<path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';

/** Active/coupe le suivi automatique et met à jour l'aspect du bouton. */
function setFollowMode(follow) {
    userMovedMap = !follow;
    if (recenterBtnEl) {
        recenterBtnEl.classList.toggle("is-following", follow);
        recenterBtnEl.setAttribute("aria-pressed", follow ? "true" : "false");
    }
}

/** setView décidé par le code : ne doit jamais être pris pour une action de l'utilisateur. */
function moveMapProgrammatically(latlng, zoom) {
    programmaticMove = true;
    try {
        map.setView(latlng, zoom);      // les évènements zoomstart/movestart partent de façon synchrone
    } finally {
        programmaticMove = false;
    }
}

function recenterOnDriver() {
    if (!driverMarker) {
        showToast("Position GPS en cours de recherche…", "info");
        return;
    }
    setFollowMode(true);
    moveMapProgrammatically(driverMarker.getLatLng(), Math.max(map.getZoom(), 15));
}

function initRecenterControl() {
    const RecenterControl = L.Control.extend({
        options: { position: "topright" },
        onAdd() {
            const bar = L.DomUtil.create("div", "leaflet-bar recenter-control");
            const btn = L.DomUtil.create("a", "recenter-btn", bar);
            btn.href = "#";
            btn.setAttribute("role", "button");
            btn.setAttribute("title", "Recentrer sur ma position");
            btn.setAttribute("aria-label", "Recentrer sur ma position");
            btn.innerHTML = RECENTER_ICON_SVG;      // SVG statique, aucune donnée externe

            L.DomEvent.disableClickPropagation(bar);
            L.DomEvent.on(btn, "click", (e) => {
                L.DomEvent.preventDefault(e);
                recenterOnDriver();
            });

            recenterBtnEl = btn;
            return bar;
        }
    });
    new RecenterControl().addTo(map);
    setFollowMode(!userMovedMap);
}

function onGpsPosition(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;

    // Alimente le cache GPS utilisé par acceptRide() dans chauffeur-api.js
    cacheGpsPosition(lat, lng);

    if (!driverMarker) {
        const icon = L.divIcon({
            html: '<div class="driver-marker-dot">🚕</div>',
            className: "driver-marker-icon",
            iconSize: [40, 40],
            iconAnchor: [20, 40]
        });
        driverMarker = L.marker([lat, lng], { icon }).addTo(map);

        if (!initialGpsDone) {
            moveMapProgrammatically([lat, lng], 15);
            initialGpsDone = true;
        }
    } else {
        driverMarker.setLatLng([lat, lng]);

        if (!userMovedMap) {
            moveMapProgrammatically([lat, lng], map.getZoom());
        }
    }

    // Itinéraire unique : rognage local du tracé, détection de déviation
    // (aucun appel réseau tant que le chauffeur suit le tracé).
    onDriverMoved(lat, lng, pos.coords.accuracy);
}

/* ═══════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════ */
function initNavigation() {
    document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
}

function switchTab(tab) {
    activeTab = tab;

    document.querySelectorAll(".nav-btn").forEach(b => {
        const isActive = b.dataset.tab === tab;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-current", isActive ? "page" : "false");
    });

    const mapEl          = document.getElementById("map");
    const sheet          = document.getElementById("mapBottomSheet");
    const fabEl          = document.getElementById("refreshFab");
    const panelCourses   = document.getElementById("panelCourses");
    const panelDashboard = document.getElementById("panelDashboard");

    if (tab === "map") {
        mapEl.classList.remove("hidden");
        sheet.classList.remove("hidden");
        fabEl.classList.remove("hidden");
        panelCourses.classList.add("hidden");
        panelDashboard.classList.add("hidden");
        setTimeout(() => map.invalidateSize(), 50);
    } else if (tab === "courses") {
        mapEl.classList.add("hidden");
        sheet.classList.add("hidden");
        fabEl.classList.add("hidden");
        panelCourses.classList.remove("hidden");
        panelDashboard.classList.add("hidden");
        renderActiveCourses();
    } else if (tab === "dashboard") {
        mapEl.classList.add("hidden");
        sheet.classList.add("hidden");
        fabEl.classList.add("hidden");
        panelCourses.classList.add("hidden");
        panelDashboard.classList.remove("hidden");
        hydrateDashboardFromCache();
        updateDashboard();
    }
}

/* ═══════════════════════════════════════════════
   STATUS TOGGLE
   BUG #1 FIX (historique) : pas d'appel manuel séparé à checkNewRides() ici
                — ça créait un second chemin d'appel concurrent au poll
                récursif, d'où le double render qui cassait "Accepter".
   ÉVOLUTION (latence au passage en ligne) : on ne laisse plus schedulePoll()
                reprendre "au prochain cycle naturel" (jusqu'à 5s d'attente,
                voir pollTimeout) — on annule ce timeout et on rappelle
                schedulePoll() tout de suite. Ça reste un seul chemin d'appel
                (schedulePoll(), avec sa propre garde isCheckingRides) : pas
                de second call path, donc BUG #1 ne peut pas revenir.
   BUG #6 FIX : onGoOffline() purge allRides et les marqueurs.
   FIX is_online : le toggle envoie la demande au serveur via setDriverStatus().
═══════════════════════════════════════════════ */

/**
 * Initialise l'état du toggle depuis la valeur is_online retournée
 * par current_user.php.
 */
function initToggleFromServer(serverIsOnline, serverStatus) {
    isOnline = serverIsOnline;
    isDisabled = serverStatus !== "active";
    const btn = document.getElementById("statusToggle");
    if (!btn) return;

    btn.classList.toggle("online", isOnline && !isDisabled);
    btn.setAttribute("aria-pressed", isOnline && !isDisabled);
    btn.disabled = isDisabled;

    const label = document.getElementById("statusLabel");
    const profileStatus = document.getElementById("profileRowStatus");
    let labelText;

    if (isDisabled) {
        labelText = "Compte désactivé";
        btn.classList.remove("online");
        if (isOnline) {
            isOnline = false;
            onGoOffline();
        }
    } else {
        labelText = isOnline ? "En ligne" : "Hors ligne";
        if (!isOnline) {
            onGoOffline();
        }
    }

    if (label) label.textContent = labelText;
    if (profileStatus) profileStatus.textContent = labelText;
}

function initStatusToggle() {
    const btn = document.getElementById("statusToggle");
    if (!btn) return;

    btn.addEventListener("click", async () => {
        // Chantier notifications natives côté chauffeur (13/07/2026) : demande
        // de permission faite ici, sur un vrai geste utilisateur (obligatoire
        // sur iOS Safari), même pattern que initFindRideBtn() côté client.
        // Sans effet si déjà accordée/refusée — ne redemande jamais deux fois.
        if (typeof window.requestNotifyPermission === "function") {
            window.requestNotifyPermission();
        }

        // Tentative de passage hors ligne → vérifier les courses actives
        if (isOnline) {
            const activeRides = allRides.filter(
                r => r.status === "accepted" || r.status === "arrived" || r.status === "started"
            );
            if (activeRides.length > 0) {
                const nb = activeRides.length;
                showToast(
                    `Impossible — ${nb} course${nb > 1 ? "s" : ""} en cours. Terminez-la${nb > 1 ? "s" : ""} d'abord.`,
                    "warning",
                    4000
                );
                // Vibration déjà déclenchée par showToast() ci-dessus (pattern générique).
                btn.classList.add("shake");
                setTimeout(() => btn.classList.remove("shake"), 500);
                return;
            }
        }

        if (isDisabled) {
            showToast("Votre compte a été désactivé par l'administrateur. Contactez l'admin.", "error", 5000);
            // Vibration déjà déclenchée par showToast() ci-dessus (pattern générique).
            return;
        }

        // Mise à jour UI immédiate (optimiste)
        const newOnline = !isOnline;
        isOnline = newOnline;
        btn.classList.toggle("online", newOnline);
        btn.setAttribute("aria-pressed", newOnline);

        const label = document.getElementById("statusLabel");
        const profileStatus = document.getElementById("profileRowStatus");
        const labelText = newOnline ? "En ligne" : "Hors ligne";
        if (label) label.textContent = labelText;
        if (profileStatus) profileStatus.textContent = labelText;

        try {
            // Envoyer au serveur
            await setDriverStatus(newOnline);

            if (newOnline) {
                showToast("Vous êtes maintenant en ligne", "success");

                // Ne pas attendre le prochain tick naturel de schedulePoll()
                // (jusqu'à 5s, voir pollTimeout) : on l'annule et on relance
                // la boucle tout de suite pour que les courses pending déjà
                // en attente apparaissent le plus vite possible. Un seul
                // chemin d'appel (schedulePoll() lui-même, avec sa garde
                // isCheckingRides) — voir le commentaire au-dessus de ce bloc.
                if (pollTimeout) clearTimeout(pollTimeout);
                schedulePoll();
            } else {
                showToast("Vous êtes hors ligne", "info");
                onGoOffline();
            }
        } catch (err) {
            // Session expirée : la redirection est déjà en cours (voir
            // setDriverStatus/chauffeur-api.js) -- inutile d'afficher un toast
            // ou de rollback une UI que l'utilisateur ne verra plus.
            if (err?.message?.includes("Session expirée")) return;

            // Échec → rollback de l'UI
            isOnline = !newOnline;
            btn.classList.toggle("online", isOnline);
            btn.setAttribute("aria-pressed", isOnline);
            if (label) label.textContent = isOnline ? "En ligne" : "Hors ligne";
            if (profileStatus) profileStatus.textContent = isOnline ? "En ligne" : "Hors ligne";
            showToast(err?.message || "Erreur de connexion au serveur", "error");
        }
    });
}

/**
 * BUG #6 FIX — purge l'état visible quand le chauffeur passe hors ligne.
 * Sans cela, les courses et marqueurs restent affichés jusqu'au prochain poll
 * qui ne vient jamais (poll bloqué par !isOnline).
 */
function onGoOffline() {
    // Hors ligne : on garde l’historique du dashboard, mais on nettoie
    // complètement le flux live pour ne plus afficher des rides pending/actives
    // qui peuvent provenir d’un ancien session ou d’une fermeture de l’app
    // avant la fin d’une course.
    hydrateDashboardFromCache();

    // Mieux que de simplement masquer certaines vues : on supprime aussi les
    // données live en mémoire pour éviter qu’un cache stale réapparaisse au
    // prochain render.
    allRides = [];
    localRideStatus.clear();

    renderPendingRides();
    if (activeTab === "courses") renderActiveCourses();
    updateNavBadges();
    updateFilterCounts();
    if (activeTab === "dashboard") updateDashboard();

    clearRoute();
}

/* ═══════════════════════════════════════════════
   REFRESH FAB
═══════════════════════════════════════════════ */
function initRefreshFab() {
    const fab = document.getElementById("refreshFab");
    if (!fab) return;
    fab.addEventListener("click", async () => {
        const icon = fab.querySelector("i");
        if (icon) icon.style.animation = "spin .4s ease";
        setTimeout(() => { if (icon) icon.style.animation = ""; }, 400);

        if (!isOnline) {
            showToast("Passez en ligne pour voir les courses", "info");
            return;
        }

        await checkNewRides();
        showToast("Carte mise à jour", "info");
    });
}

/* ═══════════════════════════════════════════════
   SHEET DRAG (collapse / expand)
═══════════════════════════════════════════════ */
function initSheetDrag() {
    const area  = document.getElementById("sheetDragArea");
    const sheet = document.getElementById("mapBottomSheet");
    if (!area || !sheet) return;

    area.addEventListener("click", () => sheet.classList.toggle("collapsed"));

    let startY = 0;
    area.addEventListener("touchstart", e => { startY = e.touches[0].clientY; }, { passive: true });
    area.addEventListener("touchend", e => {
        const dy = e.changedTouches[0].clientY - startY;
        if (dy > 40)  sheet.classList.add("collapsed");
        if (dy < -40) sheet.classList.remove("collapsed");
    }, { passive: true });
}

/* ═══════════════════════════════════════════════
   PROFILE DRAWER
═══════════════════════════════════════════════ */
function initProfileDrawer() {
    const avatarBtn    = document.getElementById("avatarBtn");
    const closeBtn     = document.getElementById("profileCloseBtn");

    if (avatarBtn) {
        avatarBtn.addEventListener("click", openProfile);
        avatarBtn.addEventListener("keydown", e => { if (e.key === "Enter") openProfile(); });
    }
    if (closeBtn) closeBtn.addEventListener("click", closeProfile);
}

function openProfile() {
    const panel = document.getElementById("profilePanel");
    if (panel) { panel.classList.add("open"); panel.setAttribute("aria-hidden", "false"); }
}

function closeProfile() {
    const panel = document.getElementById("profilePanel");
    if (panel) { panel.classList.remove("open"); panel.setAttribute("aria-hidden", "true"); }
}

// ═══════════════════════════════════════════════
// PORTEFEUILLE
// ═══════════════════════════════════════════════
function openWallet() {
  const panel = document.getElementById('walletPanel');
  if (panel) {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    loadWalletData();
  }
}

function closeWallet() {
  const panel = document.getElementById('walletPanel');
  if (panel) {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  }
}

async function loadWalletData() {
  const balanceEl = document.getElementById('walletBalance');
  const container = document.getElementById('walletTransactions');
  if (!balanceEl || !container) return;

  try {
    const data = await fetchWallet();
    if (data.status === 'success') {
      balanceEl.textContent = data.balance.toLocaleString('fr-FR') + ' FCFA';
      renderTransactions(data.transactions, container);
    } else {
      showToast('Erreur chargement du portefeuille', 'error');
    }
  } catch (e) {
    showToast('Erreur réseau', 'error');
  }
}

function formatDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function renderTransactions(transactions, container) {
  if (!container) return;
  if (!transactions || transactions.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">💳</div><div class="empty-title">Aucune transaction</div></div>';
    return;
  }

  container.innerHTML = transactions.map(tx => {
    const sign = tx.amount_fcfa >= 0 ? '+' : '';
    const typeLabel = tx.type === 'commission' ? 'Commission' :
                      tx.type === 'recharge' ? 'Recharge' : 'Ajustement';
    const statusClass = tx.status === 'completed' ? 'completed' :
                        tx.status === 'pending' ? 'pending' : 'rejected';
    const dateFormatted = formatDate(tx.created_at);
    return `
      <div class="transaction-item">
        <div class="tx-info">
          <span class="tx-type">${typeLabel}</span>
          <span class="tx-date">${dateFormatted}</span>
        </div>
        <div class="tx-amount ${tx.amount_fcfa >= 0 ? 'positive' : 'negative'}">
          ${sign}${Math.abs(tx.amount_fcfa)} FCFA
        </div>
        <span class="tx-status ${statusClass}">${tx.status}</span>
        ${tx.description ? `<div class="tx-desc">${tx.description}</div>` : ''}
      </div>
    `;
  }).join('');
}

// ── Modale de recharge ────────────────────────
let rechargeModalReturnFocus = null;

function restoreFocusBeforeModalClose(modal, returnFocus) {
  const active = document.activeElement;
  if (!modal?.contains(active)) return;

  if (returnFocus?.isConnected && !modal.contains(returnFocus)) {
    returnFocus.focus({ preventScroll: true });
  } else if (active instanceof HTMLElement) {
    active.blur();
  }
}

function openRechargeModal() {
  const modal = document.getElementById('rechargeModal');
  if (modal) {
    rechargeModalReturnFocus = document.activeElement;
    modal.removeAttribute('inert');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('rechargeAmount')?.focus({ preventScroll: true });
  }
}

function closeRechargeModal() {
  const modal = document.getElementById('rechargeModal');
  if (modal) {
    restoreFocusBeforeModalClose(modal, rechargeModalReturnFocus);
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('inert', '');
  }
  rechargeModalReturnFocus = null;
}

async function submitRechargeRequest(event) {
  event.preventDefault();
  const amount = parseInt(document.getElementById('rechargeAmount')?.value || '0');
  const operator = document.getElementById('rechargeOperator')?.value || '';
  const reference = document.getElementById('rechargeReference')?.value.trim() || '';

  if (amount <= 0) {
    showToast('Montant invalide (doit être > 0)', 'error');
    return;
  }
  if (!operator) {
    showToast('Sélectionnez un opérateur', 'error');
    return;
  }

  const submitBtn = event.target.querySelector('.modal-submit');
  const restore = setButtonLoading ? setButtonLoading(submitBtn, 'Envoi…') : (() => {});
  try {
    const res = await requestRecharge({ amount, operator, reference });
    if (res.status === 'success') {
      showToast('Demande envoyée, en attente de validation', 'success');
      closeRechargeModal();
      // Rafraîchir le portefeuille si ouvert
      if (document.getElementById('walletPanel')?.classList.contains('open')) {
        loadWalletData();
      }
    } else {
      showToast(res.message || 'Erreur lors de la demande', 'error');
    }
  } catch (e) {
    showToast('Erreur réseau', 'error');
  } finally {
    restore();
  }
}

// ═══════════════════════════════════════════════
// MES DOCUMENTS (KYC — renouvellement)
// ═══════════════════════════════════════════════

// Métadonnées d'affichage par groupe de document. `hasVerso: false` pour
// la carte grise (photo unique), cohérent avec le schéma backend
// (carte_grise_photo, une seule colonne, contrairement aux 4 autres
// groupes qui ont *_photo_recto et *_photo_verso).
const DOCUMENT_GROUPS = {
  cni:          { label: "CNI",                  numberLabel: "Numéro de CNI",             hasVerso: true  },
  carte_grise:  { label: "Carte grise",           numberLabel: "N° d'immatriculation",      hasVerso: false },
  permit:       { label: "Permis de conduire",    numberLabel: "Numéro de permis",          hasVerso: true  },
  capacity:     { label: "Carte de capacité",     numberLabel: "Numéro de carte",           hasVerso: true  },
  license:      { label: "Licence professionnelle", numberLabel: "Numéro de licence",       hasVerso: true  }
};

// Seuils d'alerte proactive (en jours avant expiration) — cf. rapport KYC,
// §3.2 : rien au-delà de 15j, alerte discrète 15-3j, alerte insistante <3j.
const DOC_ALERT_WARN_DAYS  = 15;
const DOC_ALERT_URGENT_DAYS = 3;

function openDocuments() {
  const panel = document.getElementById("documentsPanel");
  if (panel) {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    loadMyDocuments();
  }
}

function closeDocuments() {
  const panel = document.getElementById("documentsPanel");
  if (panel) {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }
}

async function loadMyDocuments() {
  const container = document.getElementById("documentsList");
  const banner = document.getElementById("documentsBanner");
  if (!container) return;

  try {
    const data = await fetchMyDocuments();
    if (data.status !== "success" || !data.documents) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Erreur de chargement</div></div>';
      return;
    }
    renderDocumentsList(data.documents, container);
    updateDocumentsAlertDot(data.documents);
    if (banner) banner.innerHTML = "";
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Erreur réseau</div></div>';
  }
}

// Le petit point rouge sur le bouton "Mes documents" du profil — visible
// sans avoir à ouvrir le tiroir, dès qu'un document est sous le seuil
// d'alerte ou déjà rejeté. Volontairement discret (pas de popup), voir
// rapport KYC §3.2.
function updateDocumentsAlertDot(documents) {
  const dot = document.getElementById("documentsAlertDot");
  if (!dot) return;
  const needsAttention = Object.values(documents).some(doc => {
    const missingData = !doc.number || !doc.expiration || !doc.photo_recto || (doc.photo_verso === undefined && true);
    return (
      (typeof doc.days_until_expiration === "number" && doc.days_until_expiration <= DOC_ALERT_WARN_DAYS) ||
      (doc.pending && doc.pending.status === "rejected") ||
      (missingData && (!doc.pending || doc.pending.status !== "approved"))
    );
  });
  dot.hidden = !needsAttention;
}

function renderDocumentsList(documents, container) {
  container.innerHTML = Object.entries(DOCUMENT_GROUPS).map(([key, meta]) => {
    const doc = documents[key] || {};
    return renderDocumentCard(key, meta, doc);
  }).join("");

  // Boutons "Modifier" — un listener par carte plutôt qu'un onclick inline,
  // pour rester cohérent avec le reste du fichier (voir initReportModal()).
  container.querySelectorAll("[data-doc-edit]").forEach(btn => {
    btn.addEventListener("click", () => openRenewalModal(btn.dataset.docEdit, documents[btn.dataset.docEdit], btn.dataset.docEditMode || "renewal"));
  });

  // Zoom sur les miniatures : clic → image en grand dans une lightbox
  // (auto-suffisante, cf. confirm-modal.js). Sans ça, un tap sur .doc-thumb
  // ne fait rien — les photos KYC ne sont pourtant lisibles qu'en grand
  // sur mobile (numéro de série, date, petits caractères).
  container.querySelectorAll(".doc-thumb").forEach(img => {
    img.addEventListener("click", () => openDocPhotoLightbox(img.src, img.alt));
  });
}

// Lightbox minimale pour zoomer une photo de document. Injecte son propre
// CSS une seule fois (même principe que confirm-modal.js) pour ne dépendre
// d'aucune règle déjà présente dans chauffeur.css.
function openDocPhotoLightbox(src, alt) {
  const STYLE_ID = "tg-doc-lightbox-styles";
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.tg-doc-lightbox-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.85);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  z-index: 100000;
}
.tg-doc-lightbox-overlay img {
  max-width: 100%; max-height: 100%;
  border-radius: 8px;
  touch-action: pinch-zoom;
}
.tg-doc-lightbox-close {
  position: absolute; top: 14px; right: 16px;
  width: 40px; height: 40px; border-radius: 50%;
  background: rgba(255,255,255,.15); color: #fff;
  border: none; font-size: 22px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
`;
    document.head.appendChild(style);
  }

  const overlay = document.createElement("div");
  overlay.className = "tg-doc-lightbox-overlay";
  overlay.innerHTML = `
    <button class="tg-doc-lightbox-close" type="button" aria-label="Fermer">&times;</button>
    <img src="${src}" alt="${alt || ""}" />
  `;
  overlay.addEventListener("click", e => {
    if (e.target === overlay || e.target.closest(".tg-doc-lightbox-close")) {
      overlay.remove();
    }
  });
  document.body.appendChild(overlay);
}

function renderDocumentCard(key, meta, doc) {
  const hasPending = doc.pending && doc.pending.status === "pending";
  const isRenewalRejected = doc.pending && doc.pending.status === "rejected";
  const missingData = !doc.number || !doc.expiration || !doc.photo_recto || (meta.hasVerso && !doc.photo_verso);

  // Examen KYC INITIAL (chauffeur_document_reviews) — système séparé des
  // renouvellements ci-dessus. Ne s'applique QUE tant que ce document n'a
  // jamais été approuvé une première fois ('approved' => le renouvellement
  // prend le relai pour toute future modification, voir plus bas).
  const initialReview = doc.initial_review;
  const isInitialPending  = initialReview && initialReview.status === "pending";
  const isInitialRejected = initialReview && initialReview.status === "rejected";

  let statusPill = '<span class="doc-status-pill approved">À jour</span>';
  if (hasPending) statusPill = '<span class="doc-status-pill pending">En vérification</span>';
  else if (isInitialRejected) statusPill = '<span class="doc-status-pill rejected">Rejeté</span>';
  else if (isInitialPending) statusPill = '<span class="doc-status-pill pending">En vérification</span>';
  else if (isRenewalRejected) statusPill = '<span class="doc-status-pill rejected">Rejeté</span>';
  else if (missingData) statusPill = '<span class="doc-status-pill pending">En attente</span>';

  const daysLeft = doc.days_until_expiration;
  let expiryWarning = "";
  if (typeof daysLeft === "number" && daysLeft <= DOC_ALERT_WARN_DAYS && !hasPending && !missingData) {
    const urgent = daysLeft <= DOC_ALERT_URGENT_DAYS;
    const text = daysLeft <= 0
      ? "Ce document est expiré"
      : `Expire dans ${daysLeft} jour${daysLeft > 1 ? "s" : ""}`;
    expiryWarning = `<div class="doc-expiry-warning" style="${urgent ? "" : "color:var(--c-amber-d)"}">
      <i class="ti ti-alert-triangle" aria-hidden="true"></i> ${text}
    </div>`;
  }

  const thumbs = [doc.photo_recto, meta.hasVerso ? doc.photo_verso : null]
    .filter(Boolean)
    .map(url => `<img class="doc-thumb" src="${url}" alt="${meta.label}" loading="lazy" />`)
    .join("");

  let pendingBanner = "";
  if (hasPending) {
    pendingBanner = `<div class="doc-pending-banner"><i class="ti ti-clock" aria-hidden="true"></i> Renouvellement envoyé, en attente de vérification par l'admin.</div>`;
  } else if (isInitialRejected) {
    pendingBanner = `<div class="doc-rejected-banner">Document rejeté à la vérification.
      <span class="doc-reject-reason">${escapeHtml(initialReview.rejection_reason || "Motif non précisé")}</span>
    </div>`;
  } else if (isInitialPending) {
    pendingBanner = `<div class="doc-pending-banner"><i class="ti ti-clock" aria-hidden="true"></i> Document envoyé, en attente de vérification par l'admin.</div>`;
  } else if (isRenewalRejected) {
    pendingBanner = `<div class="doc-rejected-banner">Renouvellement rejeté.
      <span class="doc-reject-reason">${escapeHtml(doc.pending.rejection_reason || "Motif non précisé")}</span>
    </div>`;
  } else if (missingData) {
    pendingBanner = `<div class="doc-pending-banner"><i class="ti ti-clock" aria-hidden="true"></i> Document manquant : veuillez compléter ce document pour finaliser votre KYC.</div>`;
  }

  // Bouton "Modifier"/"Resoumettre" :
  //   - masqué si un renouvellement est déjà en attente (doublon)
  //   - masqué si l'examen initial est encore 'pending' (rien à corriger
  //     tant qu'il n'a pas été examiné une première fois — demande
  //     explicite : pas de resoumission avant un premier rejet)
  //   - "Resoumettre" (-> resubmit_initial_document.php) si l'examen
  //     initial est 'rejected'
  //   - sinon comportement normal (renouvellement, "Modifier"/"Resoumettre"
  //     selon isRenewalRejected)
  let editBtn = "";
  if (hasPending || isInitialPending) {
    editBtn = "";
  } else if (isInitialRejected) {
    editBtn = `<button class="doc-btn-edit" type="button" data-doc-edit="${key}" data-doc-edit-mode="initial">
         <i class="ti ti-edit" aria-hidden="true"></i> Resoumettre
       </button>`;
  } else {
    editBtn = `<button class="doc-btn-edit" type="button" data-doc-edit="${key}" data-doc-edit-mode="renewal">
         <i class="ti ti-edit" aria-hidden="true"></i> ${isRenewalRejected ? "Resoumettre" : "Modifier"}
       </button>`;
  }

  return `
    <div class="doc-card">
      <div class="doc-card-header">
        <span class="doc-card-title">${meta.label}</span>
        ${statusPill}
      </div>
      <div class="profile-row">
        <span class="profile-row-label">${meta.numberLabel}</span>
        <span class="profile-row-val">${escapeHtml(doc.number || "—")}</span>
      </div>
      <div class="profile-row">
        <span class="profile-row-label">Expiration</span>
        <span class="profile-row-val">${doc.expiration ? formatDateOnly(doc.expiration) : "—"}</span>
      </div>
      ${thumbs ? `<div class="doc-thumbs">${thumbs}</div>` : ""}
      ${expiryWarning}
      ${pendingBanner}
      ${editBtn}
    </div>
  `;
}

function formatDateOnly(dt) {
  if (!dt) return "—";
  return new Date(dt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// escapeHtml() existe déjà côté client (client-ui.js) — absente ici tant
// que le fichier commun frontend/js/escape-html.js (chantier XSS, cf.
// audit sécurité) n'est pas extrait. Définie localement en attendant,
// pour ne pas insérer client_problem_description-like data brute.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ── Modale de renouvellement (réutilisée aussi pour la resoumission d'un
//    document rejeté à l'examen initial — voir renewalModalMode) ──────
let renewalModalMode = "renewal"; // "renewal" | "initial"
let renewalModalReturnFocus = null;

function openRenewalModal(docKey, doc, mode = "renewal") {
  const meta = DOCUMENT_GROUPS[docKey];
  if (!meta) return;

  renewalModalMode = mode;
  document.getElementById("renewalModalTitle").textContent = mode === "initial"
    ? `Corriger — ${meta.label}`
    : `Renouveler — ${meta.label}`;
  document.getElementById("renewalDocumentGroup").value = docKey;
  document.getElementById("renewalNumberLabel").textContent = meta.numberLabel;
  document.getElementById("renewalNumber").value = doc?.number || "";
  document.getElementById("renewalExpiration").value = doc?.expiration ? doc.expiration.slice(0, 10) : "";
  document.getElementById("renewalPhotoRecto").value = "";
  document.getElementById("renewalPhotoVerso").value = "";

  const versoLabel = document.getElementById("renewalPhotoVersoLabel");
  const versoInput = document.getElementById("renewalPhotoVerso");
  versoLabel.hidden = !meta.hasVerso;
  versoInput.hidden = !meta.hasVerso;
  versoInput.required = false; // jamais obligatoire (carte grise n'en a pas, et resoumission tolère de garder l'ancienne verso)

  const modal = document.getElementById("documentRenewalModal");
  if (modal) {
    renewalModalReturnFocus = document.activeElement;
    modal.removeAttribute("inert");
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }
}

function closeRenewalModal() {
  const modal = document.getElementById("documentRenewalModal");
  if (modal) {
    restoreFocusBeforeModalClose(modal, renewalModalReturnFocus);
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    modal.setAttribute("inert", "");
  }
  renewalModalReturnFocus = null;
  document.getElementById("documentRenewalForm")?.reset();
}

async function submitDocumentRenewalForm(event) {
  event.preventDefault();
  const form = document.getElementById("documentRenewalForm");
  const submitBtn = document.getElementById("renewalSubmitBtn");
  const restore = typeof setButtonLoading === "function" ? setButtonLoading(submitBtn, "Envoi…") : (() => {});

  try {
    const formData = new FormData(form);
    // "initial" : correction d'un document rejeté à l'examen initial
    // (resubmit_initial_document.php) — "renewal" : renouvellement normal
    // d'un document déjà approuvé (submit_document_renewal.php). Même
    // formulaire, deux endpoints séparés (voir renewalModalMode).
    const res = renewalModalMode === "initial"
      ? await resubmitInitialDocument(formData)
      : await submitDocumentRenewal(formData);
    if (res.status === "success") {
      showToast(
        renewalModalMode === "initial" ? "Document corrigé, en attente de vérification." : "Document envoyé, en attente de vérification.",
        "success"
      );
      closeRenewalModal();
      loadMyDocuments();
    } else {
      showToast(res.message || "Erreur lors de l'envoi.", "error");
    }
  } catch (e) {
    showToast("Erreur réseau — vérifiez votre connexion et réessayez.", "error");
  } finally {
    restore();
  }
}

// ── Initialisation des événements ─────────────
function initDocuments() {
  const openBtn = document.getElementById("documentsOpenBtn");
  const closeBtn = document.getElementById("documentsCloseBtn");
  const cancelBtn = document.getElementById("renewalCancelBtn");
  const form = document.getElementById("documentRenewalForm");
  const modalOverlay = document.getElementById("documentRenewalModal");

  if (openBtn) openBtn.addEventListener("click", openDocuments);
  if (closeBtn) closeBtn.addEventListener("click", closeDocuments);
  if (cancelBtn) cancelBtn.addEventListener("click", closeRenewalModal);
  if (form) form.addEventListener("submit", submitDocumentRenewalForm);
  if (modalOverlay) modalOverlay.addEventListener("click", e => {
    if (e.target === modalOverlay) closeRenewalModal();
  });

  // Vérification silencieuse au chargement (badge discret uniquement,
  // pas d'alerte plein écran) — cf. rapport KYC §3.3, point 1.
  loadDocumentsAlertOnly();

  // Re-vérification au retour au premier plan — cf. rapport KYC §3.3,
  // point 2. Une date d'expiration ne change qu'une fois par jour, donc
  // un simple check à chaque retour d'arrière-plan suffit ; pas besoin
  // d'un intervalle dédié qui tournerait en continu pour rien.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadDocumentsAlertOnly();
    }
  });
}

// Charge uniquement de quoi renseigner le badge (pas d'ouverture du
// tiroir) — appelé au chargement de page et au retour au premier plan.
async function loadDocumentsAlertOnly() {
  try {
    const data = await fetchMyDocuments();
    if (data.status === "success" && data.documents) {
      updateDocumentsAlertDot(data.documents);
    }
  } catch (e) {
    // silencieux — le badge reste dans son dernier état connu
  }
}

// ── Initialisation des événements ─────────────
function initWallet() {
  const openBtn = document.getElementById('walletHeaderBtn');
  const closeBtn = document.getElementById('walletCloseBtn');
  const rechargeOpenBtn = document.getElementById('rechargeOpenBtn');
  const rechargeCancelBtn = document.getElementById('rechargeCancelBtn');
  const modalOverlay = document.getElementById('rechargeModal');

  if (openBtn) openBtn.addEventListener('click', openWallet);
  if (closeBtn) closeBtn.addEventListener('click', closeWallet);
  if (rechargeOpenBtn) rechargeOpenBtn.addEventListener('click', openRechargeModal);
  if (rechargeCancelBtn) rechargeCancelBtn.addEventListener('click', closeRechargeModal);
  if (modalOverlay) modalOverlay.addEventListener('click', e => {
    if (e.target === modalOverlay) closeRechargeModal();
  });

  // Fermer le tiroir wallet avec le bouton de navigation "Retour" (si présent)
  // On peut aussi fermer via le clic en dehors du panneau (pas implémenté)
}

/* ═══════════════════════════════════════════════
   FILTER PILLS (onglet Courses)
═══════════════════════════════════════════════ */
function initFilterPills() {
    document.querySelectorAll(".filter-pill").forEach(pill => {
        pill.addEventListener("click", () => {
            setRideFilter(pill.dataset.filter);
        });
    });
}

function setRideFilter(filter) {
    if (!["accepted", "arrived", "started"].includes(filter)) return;

    activeFilter = filter;
    document.querySelectorAll(".filter-pill").forEach(pill => {
        pill.classList.toggle("active-pill", pill.dataset.filter === filter);
    });

    if (activeTab !== "courses") {
        switchTab("courses");
        return;
    }

    renderActiveCourses();
}

/* ═══════════════════════════════════════════════
   REPORT MODAL
═══════════════════════════════════════════════ */
function initReportModal() {
    const cancelBtn = document.getElementById("reportCancelBtn");
    const submitBtn = document.getElementById("reportSubmitBtn");
    const overlay   = document.getElementById("reportModal");

    if (cancelBtn) cancelBtn.addEventListener("click", closeReportModal);
    if (overlay)   overlay.addEventListener("click", e => { if (e.target === overlay) closeReportModal(); });

    if (submitBtn) {
        submitBtn.addEventListener("click", async () => {
            const text = (document.getElementById("reportTextarea")?.value || "").trim();
            if (!text) { showToast("Veuillez décrire le problème", "error"); return; }
            await submitReportAPI(reportRideId, text, submitBtn);
        });
    }
}

function openReportModal(rideId) {
    reportRideId = rideId;
    const modal = document.getElementById("reportModal");
    const sub   = document.getElementById("reportModalSub");
    const ta    = document.getElementById("reportTextarea");
    const ride  = allRides.find(item => String(item.id) === String(rideId));
    if (sub)   sub.textContent = getRideClientLabel(ride);
    if (ta)    ta.value = "";
    if (modal) {
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
        setTimeout(() => ta?.focus(), 300);
    }
}

function closeReportModal() {
    const modal = document.getElementById("reportModal");
    if (modal) {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
    }
    reportRideId = null;
}

/* ═══════════════════════════════════════════════
   TOAST SYSTEM
═══════════════════════════════════════════════ */
const TOAST_ICONS = {
    success: "ti ti-check",
    error:   "ti ti-x",
    info:    "ti ti-info-circle",
    warning: "ti ti-alert-triangle",
};

// Vibration générique appliquée à tous les toasts (chantier son/vibration,
// 06/07/2026) — pattern court unique, décision actée avec Bernardo. Les
// événements qui ont un son/pattern dédié (nouvelle course, annulation)
// appellent notifyFeedback() juste après leur propre showToast() : cet appel
// plus spécifique remplace immédiatement la vibration générique ci-dessous
// (les deux appels ne "s'additionnent" pas, le second écrase le premier).
const GENERIC_TOAST_VIBRATE_PATTERN = [35];

function showToast(message, type = "info", duration = 3000) {
    const stack = document.getElementById("toastStack");
    if (!stack) return;

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    const icon = document.createElement("i");
    icon.className = TOAST_ICONS[type] || "ti ti-info-circle";
    icon.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(text);
    stack.appendChild(toast);

    if (typeof window.notifyFeedback === "function") {
        window.notifyFeedback({ vibrate: GENERIC_TOAST_VIBRATE_PATTERN });
    }

    setTimeout(() => {
        toast.classList.add("out");
        toast.addEventListener("animationend", () => toast.remove(), { once: true });
    }, duration);
}

/* ═══════════════════════════════════════════════
   RENDER FUNCTIONS
═══════════════════════════════════════════════ */

function updateRideLists() {
    renderPendingRides();
    if (activeTab === "courses") renderActiveCourses();
    updateNavBadges();
    updateFilterCounts();
    showClientCancellationAlerts();
}

// Diffing (chantier polling optimisé, 4bis) : appelée depuis checkNewRides()
// (chauffeur-api.js) juste avant que allRides ne soit remplacé par la réponse
// fraîche — compare les ID pending des deux tableaux et ne notifie que sur un
// ID absent de l'ancien. Ne modifie rien : allRides continue d'être peuplé
// par remplacement complet ailleurs, cette fonction ne fait que décider s'il
// faut notifier.
function notifyIfNewPendingRides(previousRides, freshRides) {
    const previousPendingIds = new Set(
        (previousRides || [])
            .filter(r => r.status === "pending")
            .map(r => String(r.id))
    );

    const newPendingRides = (freshRides || [])
        .filter(r => r.status === "pending" && !previousPendingIds.has(String(r.id)));

    if (newPendingRides.length === 0) return;

    const nb = newPendingRides.length;

    // Décision actée le 06/07/2026 : trajet affiché uniquement quand une
    // seule course arrive à la fois (cas le plus fréquent en régime normal).
    // Si plusieurs arrivent dans le même cycle de poll (typiquement à la
    // connexion, plusieurs pending déjà en attente), on garde le message
    // groupé — afficher N toasts avec trajet + son4 chacun serait plus
    // fatigant qu'utile pour le chauffeur.
    let message;
    if (nb === 1) {
        const ride = newPendingRides[0];
        const pickup = ride.pickup || "?";
        const destination = ride.destination || "?";
        message = `Nouvelle course : ${pickup} → ${destination}`;
    } else {
        message = `${nb} nouvelles courses disponibles !`;
    }

    showToast(message, "success", 4000);

    // Un seul appel notifyFeedback ici, que nb soit 1 ou > 1 — le son4 ne
    // doit jouer qu'une fois par cycle de détection, jamais une fois par
    // course individuelle (évite la cacophonie au moment de la connexion).
    // notify: {...} ajouté le 13/07/2026 — jusqu'ici réservé au client
    // (voir commentaire en tête de notify-feedback.js), le chauffeur en
    // profite maintenant pour les nouvelles courses : seul événement qui
    // justifie vraiment de réveiller l'attention si l'onglet n'est pas au
    // premier plan (même limite que côté client : ne fonctionne que tant
    // que l'onglet reste ouvert quelque part, pas app totalement fermée —
    // ça, c'est le rôle du FCM ci-dessous).
    if (typeof window.notifyFeedback === "function") {
        window.notifyFeedback({
            sound: "new_ride",
            vibrate: [140, 70, 140],
            notify: { title: "Nouvelle course disponible", body: message, tag: "taxigo-ride" }
        });
    }
}

function renderPendingRides() {
    const container = document.getElementById("pendingRides");
    if (!container) return;

    const pending = isOnline ? allRides.filter(r => r.status === "pending") : [];

    const badge    = document.getElementById("pendingBadge");
    const navBadge = document.getElementById("navPendingBadge");
    if (badge) {
        badge.textContent = pending.length;
        badge.className   = "pending-badge" + (pending.length === 0 ? " zero" : "");
    }
    if (navBadge) {
        navBadge.textContent = pending.length || "";
        navBadge.classList.toggle("show", pending.length > 0);
    }

    const sheet = document.getElementById("mapBottomSheet");
    if (pending.length > 0 && sheet?.classList.contains("collapsed")) {
        sheet.classList.remove("collapsed");
    }

    container.innerHTML = "";

    if (pending.length === 0) {
        // Blocage par solde (< 500 FCFA) : distinct du cas "pas de course
        // dispo pour l'instant". Le flag est positionné par checkNewRides()
        // (chauffeur-api.js) à partir de l'en-tête X-Balance-Blocked.
        if (isOnline && window.__taxigo_balanceBlocked) {
            container.appendChild(emptyState(
                "💳",
                "Votre solde est négatif",
                "Solde < 500 FCFA — rechargez pour recevoir des courses"
            ));
            return;
        }

        container.appendChild(emptyState(
            "🚦",
            "Aucune course en attente",
            isOnline ? "Patientez…" : "Dashboard uniquement — le flux des courses est désactivé hors ligne"
        ));
        return;
    }

    pending.forEach(ride => container.appendChild(createRideCard(ride)));
}

/* ─── Tri des courses actives par proximité chauffeur ───
   Le re-tri n'est déclenché que si la position GPS du chauffeur a bougé
   de façon significative (>50m) OU si l'ensemble des courses actives a
   changé (ajout/retrait). Sans ce garde-fou, updateRideLists() tournant
   à chaque poll re-trierait (et donc ferait bouger visuellement) les
   cartes en continu — dangereux pour un chauffeur au volant. */
let lastSortDriverPos  = null;   // { lat, lng } utilisée lors du dernier tri
let lastSortActiveKey  = null;   // signature des ids de courses actives triées
let activeRideOrder    = new Map(); // rideId -> distance utilisée pour le tri

function getActiveSortKey(rides) {
    // Inclut le statut (pas seulement l'id) : un changement de statut
    // (ex. arrived → started) doit aussi déclencher un retri, car la
    // cible de distance change (pickup → destination).
    return rides
        .map(r => `${r.id}:${r.status}`)
        .sort()
        .join(",");
}

function shouldResortActiveCourses(driverPos, activeKey) {
    if (lastSortActiveKey === null) return true;
    if (activeKey !== lastSortActiveKey) return true;
    if (!driverPos) return false; // pas de position fraîche : on garde l'ordre existant
    if (!lastSortDriverPos) return true;
    return getDistanceFromLatLng(
        lastSortDriverPos.lat, lastSortDriverPos.lng,
        driverPos.lat, driverPos.lng
    ) > 0.05; // 50 mètres
}

function recomputeActiveRideOrder(active, driverPos) {
    activeRideOrder = new Map();
    if (!driverPos) return; // fallback : pas de position → ordre créé (created_at) inchangé

    active.forEach(ride => {
        let dist;
        if (ride.status === "started") {
            const destLat = parseFloat(ride.destination_lat);
            const destLng = parseFloat(ride.destination_lng);
            dist = (isNaN(destLat) || isNaN(destLng))
                ? Infinity
                : getDistanceFromLatLng(driverPos.lat, driverPos.lng, destLat, destLng);
        } else {
            // accepted / arrived → distance au point de pickup
            const pLat = parseFloat(ride.pickup_lat);
            const pLng = parseFloat(ride.pickup_lng);
            dist = (isNaN(pLat) || isNaN(pLng))
                ? Infinity
                : getDistanceFromLatLng(driverPos.lat, driverPos.lng, pLat, pLng);
        }
        activeRideOrder.set(ride.id, dist);
    });
}

function sortByActiveRideOrder(list) {
    if (activeRideOrder.size === 0) return list; // pas de position connue : ordre d'origine (created_at)
    return [...list].sort((a, b) => {
        const da = activeRideOrder.has(a.id) ? activeRideOrder.get(a.id) : Infinity;
        const db = activeRideOrder.has(b.id) ? activeRideOrder.get(b.id) : Infinity;
        return da - db;
    });
}

function renderActiveCourses() {
    const container = document.getElementById("activeRidesList");
    const subEl     = document.getElementById("activeCoursesSub");
    if (!container) return;

    const active = isOnline
        ? allRides.filter(r => r.status === "accepted" || r.status === "arrived" || r.status === "started")
        : [];

    // Position GPS courante (alimentée par onGpsPosition → cacheGpsPosition
    // dans chauffeur-api.js ; lastKnownPos est une variable top-level de ce
    // même document, donc directement lisible ici).
    const driverPos = (typeof lastKnownPos !== "undefined" && lastKnownPos)
        ? { lat: lastKnownPos.lat, lng: lastKnownPos.lng }
        : null;
    const activeKey = getActiveSortKey(active);

    if (shouldResortActiveCourses(driverPos, activeKey)) {
        recomputeActiveRideOrder(active, driverPos);
        lastSortDriverPos = driverPos;
        lastSortActiveKey = activeKey;
    }

    let filtered = sortByActiveRideOrder(active);
    if (activeFilter === "accepted") filtered = filtered.filter(r => r.status === "accepted");
    if (activeFilter === "arrived")  filtered = filtered.filter(r => r.status === "arrived");
    if (activeFilter === "started")  filtered = filtered.filter(r => r.status === "started");

    if (subEl) {
        subEl.textContent = active.length > 0
            ? `${active.length} course${active.length > 1 ? "s" : ""} active${active.length > 1 ? "s" : ""}`
            : "Aucune course active";
    }

    container.innerHTML = "";

    if (filtered.length === 0) {
        container.appendChild(emptyState(
            "🚕",
            isOnline ? "Aucune course ici" : "Mode hors ligne",
            isOnline
                ? (activeFilter === "accepted" ? "Acceptez une course depuis la carte" : "Changez le filtre")
                : "Le tableau de bord est disponible, mais les courses en temps réel sont désactivées"
        ));
        return;
    }

    filtered.forEach(ride => container.appendChild(createRideCard(ride)));
}

function updateFilterCounts() {
    if (!isOnline) {
        setText("acceptedFilterCount", 0);
        setText("arrivedFilterCount", 0);
        setText("startedFilterCount", 0);
        return;
    }

    const accepted = allRides.filter(r => r.status === "accepted").length;
    const arrived  = allRides.filter(r => r.status === "arrived").length;
    const started  = allRides.filter(r => r.status === "started").length;

    setText("acceptedFilterCount", accepted);
    setText("arrivedFilterCount", arrived);
    setText("startedFilterCount", started);
}

function updateNavBadges() {
    const active = isOnline
        ? allRides.filter(r => r.status === "accepted" || r.status === "arrived" || r.status === "started")
        : [];
    const navActiveBadge = document.getElementById("navActivesBadge");
    if (navActiveBadge) {
        navActiveBadge.textContent = active.length || "";
        navActiveBadge.classList.toggle("show", active.length > 0);
    }
}

/* ─── Ride Card ─────────────────────────────── */

function createRideCard(ride) {
    const status = ride.status;

    const card = document.createElement("article");
    card.className = `ride-card ${status}`;
    card.setAttribute("role", "listitem");

    // Header
    const header = document.createElement("div");
    header.className = "ride-card-header";

    const idEl = document.createElement("span");
    idEl.className   = "ride-id";
    idEl.textContent = status === "pending" ? "Nouvelle demande" : getRideClientLabel(ride);

    const badge = document.createElement("span");
    badge.className   = `ride-status-badge ${badgeClass(status)}`;
    badge.textContent = statusLabel(status);

    header.appendChild(idEl);
    header.appendChild(badge);

    // Route
    const route = document.createElement("div");
    route.className = "ride-route";

    const rowPickup = document.createElement("div");
    rowPickup.className = "route-row";
    const dotPickup = document.createElement("span");
    dotPickup.className = "route-dot dot-pickup";
    const labelPickup = document.createElement("span");
    labelPickup.className   = "route-label";
    labelPickup.textContent = ride.pickup;
    rowPickup.appendChild(dotPickup);
    rowPickup.appendChild(labelPickup);

    const connector = document.createElement("div");
    connector.className      = "route-connector";
    connector.style.marginLeft = "3px";

    const rowDest = document.createElement("div");
    rowDest.className = "route-row";
    const dotDest = document.createElement("span");
    dotDest.className = "route-dot dot-dest";
    const labelDest = document.createElement("span");
    labelDest.className   = "route-label";
    labelDest.textContent = ride.destination;
    rowDest.appendChild(dotDest);
    rowDest.appendChild(labelDest);

    route.appendChild(rowPickup);
    route.appendChild(connector);
    route.appendChild(rowDest);

    // Meta
    const meta = document.createElement("div");
    meta.className = "ride-meta";

    [
        { val: `👥 ${ride.passengers}` },
        { val: `📏 ${parseFloat(ride.distance_km).toFixed(1)} km` },
    ].forEach(({ val }) => {
        const item = document.createElement("span");
        item.className   = "ride-meta-item";
        item.textContent = val;
        meta.appendChild(item);
    });

    const priceItem = document.createElement("span");
    priceItem.className   = "ride-meta-item ride-price";
    priceItem.textContent = `${parseInt(ride.price_fcfa).toLocaleString()} FCFA`;
    meta.appendChild(priceItem);

    // Actions
    const actions = document.createElement("div");
    actions.className = "ride-actions";

    if (status === "pending") {
        actions.appendChild(makeActionBtn("btn-accept", "✓ Accepter", btn => acceptRide(ride.id, btn)));
        actions.appendChild(makeActionBtn("btn-refuse", "✕ Refuser",  btn => refuseRide(ride.id, btn)));
    } else if (status === "accepted") {
        actions.appendChild(makeActionBtn("btn-start",  "Arrivé", btn => arriveRide(ride.id, btn)));
        actions.appendChild(makeActionBtn("btn-cancel", "✕ Annuler",   btn => cancelRide(ride.id, btn)));
    } else if (status === "arrived") {
        actions.appendChild(makeActionBtn("btn-start",  "🚀 Commencer", btn => startRide(ride.id, btn)));
        actions.appendChild(makeActionBtn("btn-cancel", "✕ Annuler",   btn => cancelRide(ride.id, btn)));
    } else if (status === "started") {
        actions.appendChild(makeActionBtn("btn-complete", "✅ Terminer",  btn => completeRide(ride.id, btn)));
        const problemBtn = makeActionBtn("btn-problem", "⚠ Problème", () => reportProblem(ride.id));
        // Signalement déjà envoyé et pas encore traité par l'admin (lot F4) : la course
        // continue, mais on évite que le chauffeur renvoie le même signalement.
        if (ride.problem_description && !ride.problem_resolved_at) {
            problemBtn.textContent = "⚠ Signalé";
            problemBtn.disabled    = true;
            problemBtn.title       = "L'administrateur a été alerté";
        }
        actions.appendChild(problemBtn);
    }

    card.appendChild(header);
    card.appendChild(route);
    card.appendChild(meta);
    if (actions.children.length > 0) card.appendChild(actions);

    return card;
}

function makeActionBtn(cls, label, handler) {
    const btn = document.createElement("button");
    btn.className = `action-btn ${cls}`;
    btn.type      = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => handler(btn));
    return btn;
}

function emptyState(icon, title, desc) {
    const el = document.createElement("div");
    el.className = "empty-state";
    const iconEl = document.createElement("div");
    iconEl.className = "empty-icon"; iconEl.textContent = icon;
    const titleEl = document.createElement("div");
    titleEl.className = "empty-title"; titleEl.textContent = title;
    const descEl = document.createElement("div");
    descEl.className = "empty-desc"; descEl.textContent = desc;
    el.appendChild(iconEl); el.appendChild(titleEl); el.appendChild(descEl);
    return el;
}

function badgeClass(status) {
    return { pending: "badge-pending", accepted: "badge-accepted",
             arrived: "badge-arrived",
             started: "badge-started", completed: "badge-completed" }[status] || "";
}

function statusLabel(status) {
    return { pending: "En attente", accepted: "Acceptée",
             arrived: "Arrivée",
             started: "En cours",   completed: "Terminée" }[status] || status;
}

/* ═══════════════════════════════════════════════
   MAP — ITINÉRAIRE UNIQUE
   Principe : la carte se met d'abord à jour depuis l'ÉTAT LOCAL (synchrone,
   sans réseau), puis le réseau affine le tracé.
     1. updateRideMarkers()  : appelée après chaque poll ET après chaque
        action du chauffeur (via applyLocalRideStatus). Retire/ajoute les
        panneaux immédiatement ; si l'ensemble d'arrêts a changé, demande un
        recalcul de l'ordre et du tracé.
     2. Un seul calcul à la fois, "dernier gagnant" : une demande arrivée
        pendant un calcul interrompt celui-ci (AbortController) ; tout
        résultat périmé est jeté, jamais dessiné.
     3. onDriverMoved() : rogne localement la partie déjà parcourue du tracé ;
        ne déclenche un recalcul que si le chauffeur s'écarte du tracé.
═══════════════════════════════════════════════ */

/** Statut effectif des courses : statut serveur, sauf action locale récente non encore confirmée. */
function effectiveRides() {
    const now = Date.now();
    return allRides.map(r => {
        const ov = localRideStatus.get(String(r.id));
        if (!ov) return r;
        if (r.status === ov.status || now - ov.ts > LOCAL_STATUS_TTL_MS) {
            localRideStatus.delete(String(r.id));
            return r;
        }
        return { ...r, status: ov.status };
    });
}

/**
 * Applique tout de suite l'effet d'une action réussie du chauffeur (accepté,
 * arrivé, démarré, terminé, annulé) sur la carte, sans attendre le poll.
 * checkNewRides() réconcilie ensuite avec l'état serveur.
 */
function applyLocalRideStatus(id, status) {
    localRideStatus.set(String(id), { status, ts: Date.now() });
    updateRideMarkers();
}

/* ── Point d'entrée ─────────────────────────── */

function updateRideMarkers() {
    if (!map) return;

    const stops     = RoutePlanner.buildStops(effectiveRides());
    const signature = RoutePlanner.signature(stops);
    const changed   = signature !== currentSignature;

    currentStops     = stops;
    currentSignature = signature;

    // 1) Décharge / ajout immédiats des panneaux (aucun réseau)
    syncStopMarkers(stops);

    // 2) Plus aucun arrêt : on vide tout de suite
    if (!stops.length) {
        clearRouteLine();
        refreshRouteBanner();
        return;
    }

    // 3) Ensemble d'arrêts modifié : l'ancien tracé reste visible en grisé
    //    ("Recalcul…") jusqu'à l'arrivée du nouveau, qui le remplace d'un coup.
    if (changed) ghostRoute();

    if (!routePlan || routePlan.signature !== signature) {
        scheduleRouteRecompute();
    }
    refreshRouteBanner();
}

/* ── Panneaux (repères) ─────────────────────── */

function stopTypeLabel(type) {
    return type === "pickup" ? "À récupérer" : "Fin de course";
}

function syncStopMarkers(stops) {
    const groups = new Map();
    for (const s of stops) {
        if (!groups.has(s.coordKey)) groups.set(s.coordKey, []);
        groups.get(s.coordKey).push(s);
    }

    // Retrait immédiat des panneaux qui n'ont plus lieu d'être
    stopMarkers.forEach((m, k) => {
        if (!groups.has(k)) { map.removeLayer(m); stopMarkers.delete(k); }
    });

    // Numéros d'ordre : rang parmi les arrêts encore attendus, selon le dernier plan
    const keys      = new Set(stops.map(s => s.key));
    const survivors = routePlan ? routePlan.order.filter(k => keys.has(k)) : [];
    const rankOf    = new Map(survivors.map((k, i) => [k, i + 1]));
    const nextKey   = survivors[0] || null;

    groups.forEach((list, ck) => {
        list.sort((a, b) => (rankOf.get(a.key) || 99) - (rankOf.get(b.key) || 99));

        const isNext    = list.some(s => s.key === nextKey);
        const symbols   = list.map(s => {
            const shape = s.type === "pickup"
                ? '<circle cx="12" cy="10" r="3.2" fill="#fff"/>'
                : '<path d="M9 6.5v8M9.5 7h6l-1.8 2.4 1.8 2.4h-6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
            return `<span class="stop-symbol ${s.type}" role="img" aria-label="${stopTypeLabel(s.type)}">` +
                     `<svg viewBox="0 0 24 26" aria-hidden="true">` +
                       `<path class="stop-pin-body" d="M12 25s9-9.1 9-15a9 9 0 1 0-18 0c0 5.9 9 15 9 15Z"/>` +
                       shape +
                     `</svg>` +
                   `</span>`;
        }).join("");
        const html = `<div class="stop-pin${isNext ? " is-next" : ""}">${symbols}</div>`;
        const z    = isNext ? 1000 : 500 - (rankOf.get(list[0].key) || 50);

        let m = stopMarkers.get(ck);
        if (!m) {
            m = L.marker([list[0].lat, list[0].lng], {
                icon: L.divIcon({ html, className: "stop-marker-icon", iconSize: [0, 0], iconAnchor: [0, 0] }),
                zIndexOffset: z
            }).addTo(map);
            m._iconHtml = html;
            stopMarkers.set(ck, m);
        } else if (m._iconHtml !== html) {
            m.setIcon(L.divIcon({ html, className: "stop-marker-icon", iconSize: [0, 0], iconAnchor: [0, 0] }));
            m._iconHtml = html;
            m.setZIndexOffset(z);
        }

        // Popup reconstruite seulement si le contenu change (sinon elle se fermerait à chaque poll)
        const popupSig = list.map(s => `${s.key}:${s.clientName}`).join(",");
        if (m._popupSig !== popupSig) {
            const wrap = document.createElement("div");
            list.forEach((s, i) => {
                const pax  = s.pax > 1 ? ` — ${s.pax} passagers` : "";
                const item = createSafePopup(
                    `${stopTypeLabel(s.type)} — ${getRideClientLabel(s.clientName)}${pax}`,
                    s.address
                );
                if (i > 0) item.style.marginTop = "8px";
                wrap.appendChild(item);
            });
            m.unbindPopup();
            m.bindPopup(wrap);
            m._popupSig = popupSig;
        }
    });
}

/* ── Tracé ──────────────────────────────────── */

const ROUTE_STYLE_CASING = { color: "#ffffff", weight: 10, opacity: 0.9, lineCap: "round", lineJoin: "round", interactive: false };
const ROUTE_STYLE_MAIN   = { color: "#2563eb", weight: 6,  opacity: 0.95, lineCap: "round", lineJoin: "round", dashArray: null, interactive: false };
const ROUTE_STYLE_GHOST  = { color: "#94a3b8", weight: 6,  opacity: 0.8,  lineCap: "round", lineJoin: "round", dashArray: "2 10" };

function drawRouteLine(latlngs) {
    if (!routeMain) {
        routeCasing = L.polyline(latlngs, ROUTE_STYLE_CASING).addTo(map);
        routeMain   = L.polyline(latlngs, ROUTE_STYLE_MAIN).addTo(map);
    } else {
        routeCasing.setLatLngs(latlngs);
        routeMain.setLatLngs(latlngs);
        routeMain.setStyle(ROUTE_STYLE_MAIN);
    }
}

function ghostRoute() {
    if (routeMain) routeMain.setStyle(ROUTE_STYLE_GHOST);
}

/** Retire le tracé, le plan et invalide tout calcul en cours (sans toucher aux panneaux). */
function clearRouteLine() {
    if (routeCasing) { map.removeLayer(routeCasing); routeCasing = null; }
    if (routeMain)   { map.removeLayer(routeMain);   routeMain   = null; }
    routePlan          = null;
    computingSignature = "";
    offRouteSince      = null;
    routeSeq++;                                   // tout résultat en vol devient périmé
    if (routeAbort) routeAbort.abort();
}

/** Décharge complète : tracé, panneaux, bandeau. */
function clearRoute() {
    clearRouteLine();
    stopMarkers.forEach(m => map.removeLayer(m));
    stopMarkers.clear();
    currentStops     = [];
    currentSignature = "";
    refreshRouteBanner();
}

/* ── Calcul (un seul à la fois, dernier gagnant) ─ */

function scheduleRouteRecompute() {
    if (routeBusy) {
        // Interrompre le calcul en cours seulement s'il porte sur un ensemble d'arrêts
        // différent ; sinon (simple poll de 5 s) on le laisse finir.
        if (computingSignature !== currentSignature) {
            routeDirty = true;
            if (routeAbort) routeAbort.abort();
        }
        return;
    }
    runRouteRecompute();
}

async function runRouteRecompute() {
    routeBusy = true;
    try {
        do {
            routeDirty = false;

            const seq       = ++routeSeq;
            const stops     = currentStops.slice();
            const signature = currentSignature;
            const pos       = driverMarker ? driverMarker.getLatLng() : null;
            if (!stops.length || !pos) break;       // reprendra à la prochaine position GPS / au prochain poll

            computingSignature = signature;
            routeAbort         = new AbortController();

            let plan = null;
            try {
                plan = await RoutePlanner.computePlan(
                    { lat: pos.lat, lng: pos.lng }, stops,
                    { capacity: ROUTE_VEHICLE_CAPACITY, signal: routeAbort.signal }
                );
            } catch (e) {
                if (!e || e.name !== "AbortError") console.warn("computePlan:", e);
            }
            routeAbort = null;

            // Résultat périmé (course changée / annulée / hors ligne entre-temps) : jeté
            if (seq !== routeSeq || routeDirty || !plan) continue;

            plan.signature = signature;
            plan.driverArc = 0;
            plan.cursor    = 0;
            applyRoutePlan(plan);
        } while (routeDirty);
    } finally {
        routeBusy          = false;
        routeAbort         = null;
        computingSignature = "";
    }
}

function applyRoutePlan(plan) {
    routePlan     = plan;
    lastRecalcAt  = Date.now();
    offRouteSince = null;

    drawRouteLine(plan.latlngs);
    syncStopMarkers(currentStops);     // numéros d'ordre + prochain arrêt
    refreshRouteBanner();
}

/* ── Suivi du chauffeur : rognage local + déviation ─ */

function onDriverMoved(lat, lng, accuracy) {
    if (!currentStops.length) return;

    // Pas encore de plan (position GPS arrivée après les courses) : on le demande
    if (!routePlan) {
        if (!routeBusy) scheduleRouteRecompute();
        return;
    }
    // Un recalcul est attendu ou en cours pour un autre ensemble d'arrêts
    if (routePlan.signature !== currentSignature) return;

    const proj = RoutePlanner.project(routePlan.coords, routePlan.cum, lat, lng, routePlan.cursor, ROUTE_DEVIATION_M / 2);

    if (proj.dist <= ROUTE_DEVIATION_M) {
        offRouteSince = null;
        trimRoute(proj);
        return;
    }

    // GPS trop imprécis : un écart apparent ne prouve rien
    if (accuracy && accuracy > ROUTE_MAX_ACCURACY_M) return;

    const now = Date.now();
    if (offRouteSince === null) { offRouteSince = now; return; }

    if (now - offRouteSince >= ROUTE_DEVIATION_HOLD &&
        now - lastRecalcAt  >= ROUTE_RECALC_COOLDOWN &&
        !routeBusy) {
        offRouteSince = null;
        ghostRoute();
        scheduleRouteRecompute();
        refreshRouteBanner();
    }
}

/** Efface du tracé la partie déjà parcourue (calcul local, aucun réseau). */
function trimRoute(proj) {
    const now = Date.now();
    if (now - lastTrimAt < ROUTE_TRIM_THROTTLE || !routeMain) return;
    lastTrimAt = now;

    routePlan.cursor    = proj.seg;
    routePlan.driverArc = proj.arc;

    const remaining = [[proj.lat, proj.lng]].concat(routePlan.latlngs.slice(proj.seg + 1));
    routeCasing.setLatLngs(remaining);
    routeMain.setLatLngs(remaining);

    refreshRouteBanner();
}

/* ── Bandeau "Prochain arrêt" ───────────────── */

function ensureRouteBanner() {
    if (routeBanner) return routeBanner;
    const el = document.createElement("div");
    el.id        = "routeBanner";
    el.className = "route-banner hidden";
    el.setAttribute("role", "status");
    document.getElementById("map").appendChild(el);   // masqué avec la carte quand on change d'onglet
    L.DomEvent.disableClickPropagation(el);
    routeBanner = el;
    return el;
}

function formatRouteDistance(m) {
    if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
    return `${(m / 1000).toFixed(1)} km`;
}

function refreshRouteBanner() {
    if (!map) return;
    const el = ensureRouteBanner();

    if (!currentStops.length) { el.classList.add("hidden"); return; }

    const planValid = !!routePlan && routePlan.signature === currentSignature;
    const keys      = new Set(currentStops.map(s => s.key));
    const survivors = routePlan ? routePlan.order.filter(k => keys.has(k)) : [];
    const next      = currentStops.find(s => s.key === survivors[0]) || null;

    el.replaceChildren();
    el.classList.remove("hidden");
    el.classList.toggle("is-recalc", !planValid);

    const ico  = document.createElement("div");
    ico.className = "rb-ico";
    const main = document.createElement("div");
    main.className = "rb-main";
    const title = document.createElement("div");
    title.className = "rb-title";
    const sub = document.createElement("div");
    sub.className = "rb-sub";
    main.appendChild(title);
    main.appendChild(sub);
    el.appendChild(ico);
    el.appendChild(main);

    if (!next) {
        ico.textContent   = "🧭";
        title.textContent = "Calcul de l'itinéraire…";
        sub.textContent   = `${currentStops.length} arrêt${currentStops.length > 1 ? "s" : ""}`;
        return;
    }

    ico.textContent   = next.type === "pickup" ? "👤" : "🏁";
    title.textContent = `Prochain : ${stopTypeLabel(next.type)} · ${getRideClientLabel(next.clientName)}`;
    sub.textContent   = next.address || "";

    // Distance / durée jusqu'au prochain arrêt
    let remM = null, approx = !!(routePlan && routePlan.approx), secPerM = 0.12;   // ~30 km/h par défaut
    const idx = routePlan ? routePlan.order.indexOf(next.key) : -1;

    if (planValid && idx >= 0 && routePlan.stopArcs) {
        remM = Math.max(0, routePlan.stopArcs[idx] - (routePlan.driverArc || 0));
        const leg = routePlan.legs[idx];
        if (leg && leg.distance > 0) secPerM = leg.duration / leg.distance;
    } else if (driverMarker) {
        const pos = driverMarker.getLatLng();
        remM   = RoutePlanner.haversineM(pos.lat, pos.lng, next.lat, next.lng) * 1.3;
        approx = true;
    }

    if (remM !== null) {
        const mins = Math.max(1, Math.round(remM * secPerM / 60));
        const meta = document.createElement("div");
        meta.className = "rb-meta";
        meta.textContent = `${approx ? "≈ " : ""}${formatRouteDistance(remM)} · ${mins} min`;
        if (currentStops.length > 1) {
            const more = document.createElement("small");
            more.textContent = `${currentStops.length} arrêts`;
            meta.appendChild(more);
        }
        el.appendChild(meta);
    }
    if (!planValid) {
        const rc = document.createElement("div");
        rc.className = "rb-recalc";
        rc.textContent = "Recalcul…";
        main.appendChild(rc);
    }
}

function createSafePopup(title, body) {
    const el = document.createElement("div");
    const t  = document.createElement("strong");
    t.textContent = title;
    const b  = document.createElement("div");
    b.style.marginTop = "4px";
    b.textContent     = body;
    el.appendChild(t);
    el.appendChild(b);
    return el;
}

/* ═══════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════ */
function updateDashboard() {
    const sourceRides = Array.isArray(dashboardHistory) && dashboardHistory.length > 0 ? dashboardHistory : allRides;
    // Le filtre de période ne touche que les courses terminées ; "En cours" reste intact.
    const completed = sourceRides.filter(r => r.status === "completed" && inDashboardRange(r));
    const active    = sourceRides.filter(r => r.status === "accepted" || r.status === "arrived" || r.status === "started");
    const total     = completed.reduce((s, r) => {
        const price      = parseInt(r.price_fcfa || 0);
        const commission = Math.round(price * 0.20);
        return s + (price - commission);
    }, 0);
    const avg       = completed.length ? Math.round(total / completed.length) : 0;
    const dist      = completed.reduce((s, r) => s + parseFloat(r.distance_km || 0), 0);

    setText("statsCompleted", completed.length);
    setText("statsActive",    active.length);
    setText("statsTotal",     total.toLocaleString() + " FCFA");
    setText("statsAverage",   avg.toLocaleString() + " FCFA");
    setText("statsDistance",  dist.toFixed(1) + " km");

    const historyEl = document.getElementById("completedRides");
    if (!historyEl) return;
    historyEl.innerHTML = "";

    if (completed.length === 0) {
        historyEl.appendChild(emptyState("📋",
            dashboardRange ? "Aucune course sur cette période" : "Aucune course terminée", ""));
        return;
    }

    completed.slice().reverse().forEach(ride => historyEl.appendChild(createRideCard(ride)));
}

/* ═══════════════════════════════════════════════
   FILTRE DE PÉRIODE (dashboard)
   - Inactif par défaut : le dashboard reste intact.
   - Actif : filtre les courses terminées (stats + historique),
     jamais "En cours". Réinitialisable (bouton ou pastille ×).
   - Le popover n'utilise pas de focus() ni de translation hors écran.
═══════════════════════════════════════════════ */
let dashboardRange = null;   // { from: Date, to: Date } ou null = pas de filtre

// Date d'une course : on essaie les champs usuels renvoyés par l'API.
function getRideDate(ride) {
    const raw = ride.completed_at || ride.finished_at || ride.updated_at || ride.created_at || ride.date;
    if (!raw) return null;
    const d = new Date(String(raw).replace(" ", "T"));   // "2026-10-07 21:54:00" → compatible Safari
    return isNaN(d) ? null : d;
}

function inDashboardRange(ride) {
    if (!dashboardRange) return true;
    const d = getRideDate(ride);
    return !!d && d >= dashboardRange.from && d <= dashboardRange.to;
}

const pad2 = n => String(n).padStart(2, "0");
function toInputDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function parseInputDate(v, endOfDay) {
    if (!v) return null;
    const [y, m, d] = v.split("-").map(Number);
    return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
}
function shortDate(d) { return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); }

function openDateFilter() {
    const pop = document.getElementById("datePop");
    if (!pop) return;
    pop.removeAttribute("inert");
    pop.classList.add("open");
    pop.setAttribute("aria-hidden", "false");
    document.getElementById("dateBackdrop")?.classList.add("open");
    document.getElementById("dateFilterBtn")?.setAttribute("aria-expanded", "true");
}

function closeDateFilter() {
    const pop = document.getElementById("datePop");
    if (!pop) return;
    if (pop.contains(document.activeElement)) document.activeElement.blur();
    pop.classList.remove("open");
    pop.setAttribute("aria-hidden", "true");
    pop.setAttribute("inert", "");
    document.getElementById("dateBackdrop")?.classList.remove("open");
    document.getElementById("dateFilterBtn")?.setAttribute("aria-expanded", "false");
}

function applyDateFilter() {
    let from = parseInputDate(document.getElementById("dateFrom")?.value, false);
    let to   = parseInputDate(document.getElementById("dateTo")?.value, true);
    if (!from && !to) { resetDateFilter(); return; }
    if (!from) from = new Date(2000, 0, 1);
    if (!to)   to   = new Date(2100, 0, 1);
    if (from > to) [from, to] = [parseInputDate(toInputDate(to), false), parseInputDate(toInputDate(from), true)];
    dashboardRange = { from, to };
    renderDateFilterState();
    updateDashboard();
    closeDateFilter();
}

function resetDateFilter() {
    dashboardRange = null;
    const f = document.getElementById("dateFrom"), t = document.getElementById("dateTo");
    if (f) f.value = "";
    if (t) t.value = "";
    renderDateFilterState();
    updateDashboard();
    closeDateFilter();
}

function setDatePreset(preset) {
    const now = new Date();
    let from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (preset === "7")  from.setDate(from.getDate() - 6);
    if (preset === "30") from.setDate(from.getDate() - 29);
    if (preset === "month") from = new Date(now.getFullYear(), now.getMonth(), 1);
    document.getElementById("dateFrom").value = toInputDate(from);
    document.getElementById("dateTo").value   = toInputDate(now);
    applyDateFilter();
}

function renderDateFilterState() {
    const on = !!dashboardRange;
    document.getElementById("dateFilterBtn")?.classList.toggle("active", on);
    document.getElementById("dateChipRow")?.classList.toggle("show", on);
    const reset = document.getElementById("dateResetBtn");
    if (reset) reset.disabled = !on;
    if (on) {
        const a = shortDate(dashboardRange.from), b = shortDate(dashboardRange.to);
        setText("dateChipLabel", a === b ? a : `${a} – ${b}`);
    }
}

function initDateFilter() {
    document.getElementById("dateFilterBtn")?.addEventListener("click", () => {
        document.getElementById("datePop")?.classList.contains("open") ? closeDateFilter() : openDateFilter();
    });
    document.getElementById("dateBackdrop")?.addEventListener("click", closeDateFilter);
    document.getElementById("dateApplyBtn")?.addEventListener("click", applyDateFilter);
    document.getElementById("dateResetBtn")?.addEventListener("click", resetDateFilter);
    document.getElementById("dateChipReset")?.addEventListener("click", resetDateFilter);
    document.querySelectorAll("#datePop [data-preset]").forEach(b =>
        b.addEventListener("click", () => setDatePreset(b.dataset.preset)));
    renderDateFilterState();
}

function getRideClientLabel(rideOrName) {
    const fullName = String(
        typeof rideOrName === "string" ? rideOrName : rideOrName?.client_name || ""
    ).trim();
    return fullName.split(/\s+/)[0] || fullName || "Client";
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

/* ═══════════════════════════════════════════════
   ALERTE ANNULATION CLIENT
   La course a été acceptée/arrivée/démarrée puis
   annulée par le client (status -> cancelled_client).
   get_rides.php renvoie ces courses jusqu'à 24h après
   cancelled_at pour laisser le temps au polling (5s)
   de les voir même si l'app était en arrière-plan.
   Dédupliqué par ride.id : une seule alerte par course,
   même si elle reste dans allRides pendant 24h.
═══════════════════════════════════════════════ */
function showClientCancellationAlerts() {
    (allRides || []).forEach(ride => {
        if (ride.status !== "cancelled_client") return;
        const key = String(ride.id); // JSON.stringify convertit les clés en chaînes ; on normalise dès l'écriture pour que .has() reste cohérent après un rechargement depuis localStorage
        if (shownCancellations.has(key)) return;

        markAlertShown(shownCancellations, CANCELLATIONS_STORAGE_KEY, key);
        openClientCancellationAlert(ride);
    });
}

// Chantier son/vibration (06/07/2026) : remplace l'ancienne alerte plein
// écran bloquante par un toast — la déduplication (shownCancellations +
// localStorage, gérée par showClientCancellationAlerts() ci-dessus) est
// inchangée, seul l'affichage change. Le point de départ (ride.pickup) est
// déjà renvoyé par get_rides.php, aucun changement backend nécessaire.
function openClientCancellationAlert(ride) {
    const body = ride.pickup
        ? `Course à ${ride.pickup} annulée`
        : "Une course a été annulée";
    showToast(body, "warning", 5000);

    if (typeof window.notifyFeedback === "function") {
        window.notifyFeedback({
            sound: "cancelled",
            vibrate: [100, 60, 100, 60, 100],
            notify: { title: "Course annulée", body, tag: "taxigo-ride" }
        });
    }
}

/* ═══════════════════════════════════════════════
   UTILITAIRES GÉOMÉTRIE
═══════════════════════════════════════════════ */
function getDistanceFromLatLng(lat1, lng1, lat2, lng2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2 +
                 Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                 Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ═══════════════════════════════════════════════
   PUSH PREMIER PLAN → rafraîchissement immédiat
   push-notifications.js émet cet évènement quand un message FCM arrive
   alors que l'app est ouverte (ex. annulation par le client) : on
   rafraîchit tout de suite au lieu d'attendre le prochain poll (≤ 5 s),
   pour décharger la carte sans délai.
═══════════════════════════════════════════════ */
let lastPushRefreshAt = 0;
window.addEventListener("taxigo:push-foreground", () => {
    if (!isOnline || isCheckingRides) return;   // un poll en cours apportera l'état à jour
    const now = Date.now();
    if (now - lastPushRefreshAt < 1500) return;
    lastPushRefreshAt = now;
    checkNewRides();
});