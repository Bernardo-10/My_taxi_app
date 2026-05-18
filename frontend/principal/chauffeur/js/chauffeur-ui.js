/**
 * chauffeur-ui.js — TaxiGo Interface Chauffeur
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
 */

/* ═══════════════════════════════════════════════
   ÉTAT GLOBAL
═══════════════════════════════════════════════ */
let map;
let driverMarker        = null;
let allRides            = [];
let rideMarkers         = [];
let destinationMarkers  = [];
let destinationMap      = new Map();
let routeLayers         = [];
let routeCache          = new Map();

// Flags concurrence
let isUpdatingRoutes    = false;
let isCheckingRides     = false;

// GPS
let gpsWatchId          = null;
let userMovedMap        = false;
let initialGpsDone      = false;

// Polling
let pollTimeout         = null;
let positionTimeout     = null;

// Tab / filter state
let activeTab           = "map";
let activeFilter        = "all";

// Report modal state
let reportRideId        = null;

// Statut en ligne
let isOnline            = false;

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
    initUserHeader("login.html");
    initMap();
    initNavigation();
    initSheetDrag();
    initStatusToggle();
    initRefreshFab();
    initProfileDrawer();
    initReportModal();
    initFilterPills();

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
        await checkNewRides();
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

/* ═══════════════════════════════════════════════
   MAP
═══════════════════════════════════════════════ */
function initMap() {
    map = L.map("map", { zoomControl: false }).setView([4.05, 9.76], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    L.control.zoom({ position: "topright" }).addTo(map);

    map.on("movestart", (e) => {
        if (!e.originalEvent) return;
        userMovedMap = true;
    });

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
            map.setView([lat, lng], 15);
            initialGpsDone = true;
        }
    } else {
        driverMarker.setLatLng([lat, lng]);

        if (!userMovedMap) {
            map.setView([lat, lng], map.getZoom());
        }
    }
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
        updateDashboard();
    }
}

/* ═══════════════════════════════════════════════
   STATUS TOGGLE
   BUG #1 FIX : pas de checkNewRides() manuel ici.
                schedulePoll() reprend au prochain cycle si isOnline=true.
   BUG #6 FIX : onStatusChange(false) purge allRides et les marqueurs.
═══════════════════════════════════════════════ */
function initStatusToggle() {
    const btn = document.getElementById("statusToggle");
    if (!btn) return;

    btn.addEventListener("click", () => {
        // Tentative de passage hors ligne → vérifier les courses actives
        if (isOnline) {
            const activeRides = allRides.filter(
                r => r.status === "accepted" || r.status === "started"
            );
            if (activeRides.length > 0) {
                const nb = activeRides.length;
                showToast(
                    `Impossible — ${nb} course${nb > 1 ? "s" : ""} en cours. Terminez-la${nb > 1 ? "s" : ""} d'abord.`,
                    "warning",
                    4000
                );
                // Vibration courte si supportée
                if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
                // Shake visuel du bouton
                btn.classList.add("shake");
                setTimeout(() => btn.classList.remove("shake"), 500);
                return; // Annuler le toggle
            }
        }

        isOnline = !isOnline;
        btn.classList.toggle("online", isOnline);
        btn.setAttribute("aria-pressed", isOnline);

        const label = document.getElementById("statusLabel");
        const profileStatus = document.getElementById("profileRowStatus");
        const labelText = isOnline ? "En ligne" : "Hors ligne";
        if (label) label.textContent = labelText;
        if (profileStatus) profileStatus.textContent = labelText;

        if (isOnline) {
            showToast("Vous êtes maintenant en ligne", "success");
        } else {
            showToast("Vous êtes hors ligne", "info");
            onGoOffline();
        }
    });
}

/**
 * BUG #6 FIX — purge l'état visible quand le chauffeur passe hors ligne.
 * Sans cela, les courses et marqueurs restent affichés jusqu'au prochain poll
 * qui ne vient jamais (poll bloqué par !isOnline).
 */
function onGoOffline() {
    // Vider la liste des courses
    allRides = [];
    renderPendingRides();
    if (activeTab === "courses") renderActiveCourses();
    updateNavBadges();

    // Purger les marqueurs et routes de la carte
    rideMarkers.forEach(m => map.removeLayer(m));
    rideMarkers = [];
    destinationMarkers.forEach(m => map.removeLayer(m));
    destinationMarkers = [];
    routeLayers.forEach(l => map.removeLayer(l));
    routeLayers = [];
    routeCache.clear();
    destinationMap.clear();
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

/* ═══════════════════════════════════════════════
   FILTER PILLS (onglet Courses)
═══════════════════════════════════════════════ */
function initFilterPills() {
    document.querySelectorAll(".filter-pill").forEach(pill => {
        pill.addEventListener("click", () => {
            document.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active-pill"));
            pill.classList.add("active-pill");
            activeFilter = pill.dataset.filter;
            renderActiveCourses();
        });
    });
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
    if (sub)   sub.textContent = `Course #${rideId}`;
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
}

function renderPendingRides() {
    const container = document.getElementById("pendingRides");
    if (!container) return;

    const pending = allRides.filter(r => r.status === "pending");

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
        container.appendChild(emptyState(
            "🚦",
            "Aucune course en attente",
            isOnline ? "Patientez…" : "Passez en ligne pour recevoir des demandes"
        ));
        return;
    }

    pending.forEach(ride => container.appendChild(createRideCard(ride)));
}

function renderActiveCourses() {
    const container = document.getElementById("activeRidesList");
    const subEl     = document.getElementById("activeCoursesSub");
    if (!container) return;

    const active = allRides.filter(r => r.status === "accepted" || r.status === "started");

    let filtered = active;
    if (activeFilter === "accepted") filtered = active.filter(r => r.status === "accepted");
    if (activeFilter === "started")  filtered = active.filter(r => r.status === "started");

    if (subEl) {
        subEl.textContent = active.length > 0
            ? `${active.length} course${active.length > 1 ? "s" : ""} active${active.length > 1 ? "s" : ""}`
            : "Aucune course active";
    }

    container.innerHTML = "";

    if (filtered.length === 0) {
        container.appendChild(emptyState(
            "🚕",
            "Aucune course ici",
            activeFilter === "all" ? "Acceptez une course depuis la carte" : "Changez le filtre"
        ));
        return;
    }

    filtered.forEach(ride => container.appendChild(createRideCard(ride)));
}

function updateNavBadges() {
    const active         = allRides.filter(r => r.status === "accepted" || r.status === "started");
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
    idEl.textContent = `Course #${ride.id}`;

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
        actions.appendChild(makeActionBtn("btn-start",  "🚀 Commencer", btn => startRide(ride.id, btn)));
        actions.appendChild(makeActionBtn("btn-cancel", "✕ Annuler",   btn => cancelRide(ride.id, btn)));
    } else if (status === "started") {
        actions.appendChild(makeActionBtn("btn-complete", "✅ Terminer",  btn => completeRide(ride.id, btn)));
        actions.appendChild(makeActionBtn("btn-problem",  "⚠ Problème", () => reportProblem(ride.id)));
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
             started: "badge-started", completed: "badge-completed" }[status] || "";
}

function statusLabel(status) {
    return { pending: "En attente", accepted: "Acceptée",
             started: "En cours",   completed: "Terminée" }[status] || status;
}

/* ═══════════════════════════════════════════════
   MAP MARKERS & ROUTES
═══════════════════════════════════════════════ */
async function updateRideMarkers() {
    if (isUpdatingRoutes) return;
    isUpdatingRoutes = true;

    try {
        const driverPos = driverMarker ? driverMarker.getLatLng() : null;
        if (!driverPos) return;

        const { lat: driverLat, lng: driverLng } = driverPos;
        const activeRides = allRides.filter(r => r.status === "accepted" || r.status === "started");
        const activeIds   = new Set(activeRides.map(r => r.id));

        routeCache.forEach((_, id) => { if (!activeIds.has(id)) routeCache.delete(id); });

        rideMarkers.forEach(m => map.removeLayer(m));         rideMarkers = [];
        destinationMarkers.forEach(m => map.removeLayer(m));  destinationMarkers = [];
        routeLayers.forEach(l => map.removeLayer(l));          routeLayers = [];
        destinationMap.clear();

        for (const ride of activeRides) {
            const pickupLat = parseFloat(ride.pickup_lat);
            const pickupLng = parseFloat(ride.pickup_lng);
            const destLat   = parseFloat(ride.destination_lat);
            const destLng   = parseFloat(ride.destination_lng);

            if ([pickupLat, pickupLng, destLat, destLng].some(isNaN)) continue;

            if (ride.status === "accepted") {
                const pm = L.marker([pickupLat, pickupLng], {
                    icon: L.divIcon({ html: "📍", className: "pickup-marker", iconSize: [30, 30], iconAnchor: [15, 30] })
                }).addTo(map);
                pm.bindPopup(createSafePopup(`Départ — Course #${ride.id}`, ride.pickup));
                rideMarkers.push(pm);
            }

            const destKey = `${destLat.toFixed(5)},${destLng.toFixed(5)}`;
            if (!destinationMap.has(destKey)) {
                const dm = L.marker([destLat, destLng], {
                    icon: L.icon({
                        iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png",
                        shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png",
                        iconSize: [25, 41], iconAnchor: [12, 41], shadowSize: [41, 41]
                    })
                }).addTo(map);
                destinationMarkers.push(dm);
                destinationMap.set(destKey, { marker: dm, rides: [ride.id], destination: ride.destination });
            } else {
                destinationMap.get(destKey).rides.push(ride.id);
            }

            const cacheKey = String(ride.id);
            const cached   = routeCache.get(cacheKey);
            const moved    = !cached || getDistanceFromLatLng(driverLat, driverLng, cached.driverLat, cached.driverLng) >= 0.1;

            if (!moved && cached.layers) {
                cached.layers.forEach(l => l.addTo(map));
            } else {
                const layers = [];

                if (ride.status === "accepted") {
                    const r1 = await calculateRoute(driverLng, driverLat, pickupLng, pickupLat);
                    if (r1) {
                        const l = L.geoJSON(r1, { style: { color: "#f59e0b", weight: 5, opacity: .85 } }).addTo(map);
                        layers.push(l); routeLayers.push(l);
                    }
                    const r2 = await calculateRoute(pickupLng, pickupLat, destLng, destLat);
                    if (r2) {
                        const l = L.geoJSON(r2, { style: { color: "#10b981", weight: 5, opacity: .8, dashArray: "6,4" } }).addTo(map);
                        layers.push(l); routeLayers.push(l);
                    }
                } else if (ride.status === "started") {
                    const r = await calculateRoute(driverLng, driverLat, destLng, destLat);
                    if (r) {
                        const l = L.geoJSON(r, { style: { color: "#3b82f6", weight: 5, opacity: .85 } }).addTo(map);
                        layers.push(l); routeLayers.push(l);
                    }
                }

                routeCache.set(cacheKey, { driverLat, driverLng, layers, ts: Date.now() });
            }
        }

        destinationMap.forEach(info => {
            const popupEl  = document.createElement("div");
            const titleEl  = document.createElement("strong");
            titleEl.textContent = "Destination";
            const locEl    = document.createElement("p");
            locEl.style.margin  = "4px 0";
            locEl.textContent   = info.destination;
            const ridesEl  = document.createElement("p");
            ridesEl.style.margin  = "0";
            ridesEl.textContent   = info.rides.length > 1
                ? `${info.rides.length} courses : #${info.rides.join(", #")}`
                : `Course #${info.rides[0]}`;
            popupEl.appendChild(titleEl);
            popupEl.appendChild(locEl);
            popupEl.appendChild(ridesEl);
            info.marker.bindPopup(popupEl);
        });

    } finally {
        isUpdatingRoutes = false;
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
    const completed = allRides.filter(r => r.status === "completed");
    const active    = allRides.filter(r => r.status === "accepted" || r.status === "started");
    const total     = completed.reduce((s, r) => s + parseInt(r.price_fcfa || 0), 0);
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
        historyEl.appendChild(emptyState("📋", "Aucune course terminée", ""));
        return;
    }

    completed.slice().reverse().forEach(ride => historyEl.appendChild(createRideCard(ride)));
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
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