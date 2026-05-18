/* ============================================================
   TAXIGO â€” client-ui.js
   Architecture: AppState + Bottom Sheet + 3 onglets natifs
   client-api.js reste intact (aucune modification)
   ============================================================ */

// â”€â”€ Variables globales attendues par client-api.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let currentDriverPosition = { lat: null, lng: null };  // pour le suivi ETA en temps réel
let map;
let routeLayer        = null;
let pickupMarker      = null;
let destinationMarker = null;
let driverRouteLayer  = null;
let driverPositionMarker = null;
let pickupCoords      = null;
let destinationCoords = null;
let currentRideId     = null;
let rideStatusCheckInterval = null;
let driverStatusInterval    = null;
let rideAccepted      = false;
let lastDriverLat     = null;
let lastDriverLng     = null;
let userRides         = [];
let etaUpdateInterval = null;
// â”€â”€ AppState â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const AppState = {
  activeTab: "map",   // 'map' | 'ride' | 'profile'
  rideState: "idle",  // 'idle' | 'searching' | 'accepted' | 'arrived' | 'started' | 'completed'
  passengers: 1,
  currentUser: null,
  currentDriver: null,
  pickupText: "",
  destinationText: ""
};

// â”€â”€ DOM refs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let $panels      = {};
let $navBtns     = {};
let $rideStates  = {};

// â”€â”€ INIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.addEventListener("DOMContentLoaded", () => {
  cacheDOM();
  syncAppMode();
  initMap();
  initUserSession();
  initPassengerCounter();
  initDestinationOverlay();
  initNavigation();
  initFindRideBtn();
  initCancelBtns();
  initDriverActions();
  initReportProblem();
  initRefreshBtn();
  initProfileTabs();
  watchUserPosition();
});

function cacheDOM() {
  $panels   = {
    map:     document.getElementById("sheet-map"),
    ride:    document.getElementById("sheet-ride"),
    profile: document.getElementById("sheet-profile")
  };
  $navBtns  = {
    map:     document.getElementById("navMap"),
    ride:    document.getElementById("navRide"),
    profile: document.getElementById("navProfile")
  };
  $rideStates = {
    searching: document.getElementById("rideSearching"),
    accepted:  document.getElementById("rideAcceptedMsg")
  };
}

// â”€â”€ NAVIGATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function switchTab(name) {
  if (!$panels[name]) return;
  AppState.activeTab = name;
  syncAppMode();

  Object.entries($panels).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle("active-sheet", key === name);
  });

  Object.entries($navBtns).forEach(([key, btn]) => {
    if (btn) btn.classList.toggle("active", key === name);
  });

  if (name === "map") {
    setTimeout(() => map && map.invalidateSize(), 50);
  }
}

function syncAppMode() {
  const app = document.getElementById("app");
  if (!app) return;

  app.classList.toggle("ride-searching", AppState.rideState === "searching");
  app.classList.toggle("ride-accepted", AppState.rideState === "accepted" || AppState.rideState === "arrived" || AppState.rideState === "started");
  app.classList.toggle("tab-map", AppState.activeTab === "map");
  app.classList.toggle("tab-ride", AppState.activeTab === "ride");
  app.classList.toggle("tab-profile", AppState.activeTab === "profile");
}

function initNavigation() {
  Object.entries($navBtns).forEach(([name, btn]) => {
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (btn.disabled) {
        showToast("Lancez d'abord une course");
        return;
      }
      switchTab(name);
    });
  });
}

// â”€â”€ CARTE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initMap() {
  map = L.map("map", { zoomControl: false }).setView([4.0511, 9.7679], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19
  }).addTo(map);

  L.control.zoom({ position: "topright" }).addTo(map);
  getUserLocation();
}

function getUserLocation() {
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      pickupCoords = { lat, lng };
      map.setView([lat, lng], 16);
      updateMarker("pickup", lat, lng);
      pickupMarker.bindPopup(`Vous êtes ici (+/-${Math.round(accuracy)} m)`).openPopup();

      try {
        const addr = await reverseGeocode(lat, lng);
        const pickupEl = document.getElementById("pickup");
        if (pickupEl) {
          pickupEl.value = addr || "Position inconnue";
          AppState.pickupText = pickupEl.value;
        }
      } catch {}
    },
    (err) => console.error("Géolocalisation:", err),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function watchUserPosition() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      pickupCoords = { lat, lng };
      if (pickupMarker) pickupMarker.setLatLng([lat, lng]);
      else updateMarker("pickup", lat, lng);
    },
    (err) => console.error("Watch:", err),
    { enableHighAccuracy: true, maximumAge: 0 }
  );
}

function updateMarker(type, lat, lng) {
  if (type === "pickup") {
    if (pickupMarker) map.removeLayer(pickupMarker);
    pickupMarker = L.marker([lat, lng], { draggable: true }).addTo(map).bindPopup("Déplacez-moi");
    pickupMarker.on("dragend", async () => {
      const { lat, lng } = pickupMarker.getLatLng();
      pickupCoords = { lat, lng };
      const addr = await reverseGeocode(lat, lng);
      document.getElementById("pickup").value = addr || "Position ajustée";
      AppState.pickupText = document.getElementById("pickup").value;
      pickupMarker.bindPopup("Position mise à jour").openPopup();
    });
  } else {
    if (destinationMarker) map.removeLayer(destinationMarker);
    destinationMarker = L.marker([lat, lng]).addTo(map).bindPopup("Destination");
  }
  map.setView([lat, lng], 14);
}

// â”€â”€ COMPTEUR PASSAGERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initPassengerCounter() {
  const display  = document.getElementById("paxValue");
  const hidden   = document.getElementById("passengers");
  const decrease = document.getElementById("paxMinus");
  const increase = document.getElementById("paxPlus");

  if (!display || !hidden || !decrease || !increase) return;

  function update() {
    display.textContent = AppState.passengers;
    hidden.value = AppState.passengers;
  }
  decrease.addEventListener("click", () => {
    if (AppState.passengers > 1) { AppState.passengers--; update(); }
  });
  increase.addEventListener("click", () => {
    if (AppState.passengers < 4) { AppState.passengers++; update(); }
  });
}

// â”€â”€ OVERLAY DESTINATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initDestinationOverlay() {
  const destInput  = document.getElementById("destination");
  const overlay    = document.getElementById("searchOverlay");
  const overlayInput = document.getElementById("destinationOverlay");
  const closeBtn   = document.getElementById("searchBack");
  const resultsEl  = document.getElementById("overlayResults");
  const recentSection = document.getElementById("recentDestinations");
  const recentEl   = document.getElementById("recentList");
  const labelEl    = recentSection ? recentSection.querySelector(".recent-label") : null;
  let debounceT    = null;

  if (!destInput || !overlay || !overlayInput || !closeBtn || !resultsEl || !recentEl || !labelEl) return;

  // Ouvrir l'overlay
  destInput.addEventListener("focus", () => openSearchOverlay());
  destInput.addEventListener("click", () => openSearchOverlay());

  function openSearchOverlay() {
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => overlay.classList.add("visible"));
    overlayInput.value = destInput.value || "";
    overlayInput.focus();
    showRecentDestinations();
  }

  function closeSearchOverlay() {
    overlay.classList.remove("visible");
    setTimeout(() => { overlay.classList.add("hidden"); }, 230);
    destInput.blur();
  }

  closeBtn.addEventListener("click", closeSearchOverlay);

  // Recherche avec debounce
  overlayInput.addEventListener("input", () => {
    const q = overlayInput.value.trim();
    if (debounceT) clearTimeout(debounceT);

    if (q.length < 2) {
      showRecentDestinations();
      resultsEl.innerHTML = "";
      return;
    }
    labelEl.textContent = "Résultats proches";
    recentEl.innerHTML  = "";

    debounceT = setTimeout(() => fetchOverlayResults(q), 300);
  });

  async function fetchOverlayResults(query) {
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6&lat=4.05&lon=9.76`;
      const res  = await fetch(url);
      const data = await res.json();

      let features = (data.features || []).filter(f => {
        const cc = (f.properties.country_code || "").toLowerCase();
        const c  = (f.properties.country || "").toLowerCase();
        return cc === "cm" || c.includes("cam") || !c;
      });

      resultsEl.innerHTML = "";
      features.forEach(f => {
        const name  = f.properties.name || "";
        const city  = f.properties.city || f.properties.state || f.properties.country || "";
        const dist  = f.properties.distance ? `${(f.properties.distance/1000).toFixed(0)} km` : "";
        const label = city ? `${name}, ${city}` : name;
        const lat   = f.geometry.coordinates[1];
        const lng   = f.geometry.coordinates[0];

        const item = document.createElement("div");
        item.className = "overlay-result-item";
        item.innerHTML = `
          <div class="result-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          </div>
          <div>
            <div class="result-name">${name}</div>
            <div class="result-sub">${city}${dist ? " · " + dist : ""}</div>
          </div>`;

        item.addEventListener("click", () => {
          destinationCoords = { lat, lng };
          destInput.value   = label;
          overlayInput.value = label;
          AppState.destinationText = label;
          updateMarker("destination", lat, lng);
          saveRecentDestination({ label, lat, lng });
          closeSearchOverlay();
        });
        resultsEl.appendChild(item);
      });
    } catch (e) {
      console.error("Overlay search:", e);
    }
  }

  function showRecentDestinations() {
    labelEl.textContent = "Destinations récentes";
    const recents = getRecentDestinations();
    recentEl.innerHTML = "";
    if (!recents.length) { labelEl.textContent = "Tapez une adresse..."; return; }

    recents.forEach(r => {
      const item = document.createElement("div");
        item.className = "recent-item";
      item.innerHTML = `
        <div class="recent-icon">↻</div>
        <div>
          <div class="recent-name">${r.label}</div>
          <div class="recent-sub">Récent</div>
        </div>`;
      item.addEventListener("click", () => {
        destinationCoords = { lat: r.lat, lng: r.lng };
        destInput.value   = r.label;
        overlayInput.value = r.label;
        AppState.destinationText = r.label;
        updateMarker("destination", r.lat, r.lng);
        closeSearchOverlay();
      });
      recentEl.appendChild(item);
    });
  }
}

function saveRecentDestination(dest) {
  try {
    let recents = JSON.parse(localStorage.getItem("taxigo_recents") || "[]");
    recents = recents.filter(r => r.label !== dest.label);
    recents.unshift(dest);
    recents = recents.slice(0, 3);
    localStorage.setItem("taxigo_recents", JSON.stringify(recents));
  } catch {}
}
function getRecentDestinations() {
  try { return JSON.parse(localStorage.getItem("taxigo_recents") || "[]"); }
  catch { return []; }
}

// â”€â”€ TROUVER UNE COURSE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initFindRideBtn() {
  document.getElementById("findRideBtn").addEventListener("click", async () => {
    AppState.pickupText      = document.getElementById("pickup").value.trim();
    AppState.destinationText = document.getElementById("destination").value.trim();

    // Afficher les dÃ©tails dans le panel ride avant de switch
    document.getElementById("summaryPickup").textContent      = AppState.pickupText || "-";
    document.getElementById("summaryDest").textContent = AppState.destinationText || "-";

    await findRoute(); // fonction de client-api.js
  });
}

// â”€â”€ SUIVI DE COURSE (hooks sur client-api) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// showWaitingMessage est appelÃ© par sendToBackend de client-api.js
function showWaitingMessage() {
  AppState.rideState = "searching";

  // S'assurer que le résumé est rempli avant d'afficher
  const pickupEl = document.getElementById("pickup");
  const destEl   = document.getElementById("destination");
  document.getElementById("summaryPickup").textContent = pickupEl?.value || AppState.pickupText || "-";
  document.getElementById("summaryDest").textContent   = destEl?.value   || AppState.destinationText || "-";

  setRideState("searching");
  syncAppMode();

  // Activer l'onglet Course et basculer automatiquement
  $navBtns.ride.disabled = false;
  switchTab("ride");
}

function setRideState(state) {
  Object.entries($rideStates).forEach(([key, el]) => {
    if (el) el.classList.toggle("hidden", key !== state);
  });
}

// updateRideStatusMessage est appelÃ© par client-api.js pour les mises Ã  jour
function updateRideStatusMessage(msg) {
  const el = document.getElementById("rideStatusMessage");
  if (el) el.textContent = msg;

  const normalized = String(msg || "").toLowerCase();
  // onRideAccepted est désormais appelé directement depuis client-api.js avec les données structurées
  if (normalized.includes("termin") || normalized.includes("completed")) onRideCompleted();
  else if (normalized.includes("annul") && !normalized.includes("accept")) onRideCancelled();
}

// Accepte soit un objet { name, plate, car, rating } (depuis client-api.js)
// soit une chaîne texte (fallback legacy)


function setDriverInfo({ name, color, plate, rating }) {
  document.getElementById("rideDriverName").textContent   = name    || "-";
  document.getElementById("rideDriverCar").textContent    = color ? `Couleur ${color}` : "-";
  document.getElementById("rideDriverPlate").textContent  = plate   || "-";
  document.getElementById("rideDriverRating").textContent = rating  || "-";

  const initial = (name || "C").charAt(0).toUpperCase();
  document.getElementById("rideDriverInitial").textContent = initial;
}

function initDriverActions() {
  document.getElementById("driverCallBtn")?.addEventListener("click", () => {
    const phone = normalizePhone(AppState.currentDriver?.phone);
    if (phone) {
      window.location.href = `tel:${phone}`;
      return;
    }
    showToast("Numéro chauffeur indisponible.");
  });

  document.getElementById("driverMsgBtn")?.addEventListener("click", () => {
    const phone = normalizePhone(AppState.currentDriver?.phone);
    if (phone) {
      window.location.href = `sms:${phone}`;
      return;
    }
    showToast("Messagerie chauffeur indisponible.");
  });
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function updateDriverETA(distanceMeters, durationSeconds) {
  const distanceEl = document.getElementById("driverDistanceToPickup");
  const etaEl = document.getElementById("driverETA");
  if (!distanceEl || !etaEl) return;

  if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
    distanceEl.textContent = "-";
    etaEl.textContent = "-";
    return;
  }

  const km = distanceMeters / 1000;
  const minutes = Math.max(1, Math.round(durationSeconds / 60));
  distanceEl.textContent = km < 1 ? `${Math.round(distanceMeters)} m` : `${km.toFixed(1)} km`;
  etaEl.textContent = `${minutes} min`;
}

function onRideCancelled() {
  AppState.rideState = "idle";
  currentRideId = null;
  rideAccepted = false;
  AppState.currentDriver = null;
  if (rideStatusCheckInterval) clearInterval(rideStatusCheckInterval);
  if (driverStatusInterval) clearInterval(driverStatusInterval);
  if (etaUpdateInterval) clearInterval(etaUpdateInterval);
  $navBtns.ride.disabled = true;
  syncAppMode();
  switchTab("map");
  resetMapPanel();
}

function resetMapPanel() {
  document.getElementById("fareStrip").style.display = "none";
  document.getElementById("routePill").classList.add("hidden");
  if (routeLayer)        { map.removeLayer(routeLayer);        routeLayer = null; }
  if (destinationMarker) { map.removeLayer(destinationMarker); destinationMarker = null; }
  if (driverPositionMarker) { map.removeLayer(driverPositionMarker); driverPositionMarker = null; }
  if (driverRouteLayer)  { map.removeLayer(driverRouteLayer);  driverRouteLayer = null; }
  destinationCoords = null;
  document.getElementById("destination").value = "";
  document.getElementById("routeDistance").textContent = "-";
  document.getElementById("routeDuration").textContent = "-";
  document.getElementById("routePrice").textContent    = "-";
}

// Hook pour afficher le chip et fare-row aprÃ¨s calcul d'itinÃ©raire
// findRoute() de client-api.js met Ã  jour directement les spans
// On surcharge la fin de findRoute via un MutationObserver sur #routeDistance
(function observeFareUpdate() {
  const obs = new MutationObserver(() => {
    const dist = document.getElementById("routeDistance")?.textContent;
    const dur  = document.getElementById("routeDuration")?.textContent;
    const price = document.getElementById("routePrice")?.textContent;

    if (dist && dist !== "-") {
      // Mettre Ã  jour le rÃ©sumÃ© du panel Course
      document.getElementById("summaryDist").textContent = dist;
      document.getElementById("summaryDur").textContent = dur  || "-";
      document.getElementById("summaryPrice").textContent    = price || "-";

      // Afficher le chip + fare-row
      const chip = document.getElementById("routePill");
      chip.classList.remove("hidden");
      document.getElementById("pillDistance").textContent = dist;
      document.getElementById("pillDuration").textContent = dur  || "-";
      document.getElementById("fareStrip").style.display   = "flex";
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("routeDistance");
    if (el) obs.observe(el, { childList: true, characterData: true, subtree: true });
  });
})();

// â”€â”€ ANNULATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initCancelBtns() {
  // Bouton dans l'Ã©tat "searching"
  const cancelSearch = document.getElementById("cancelRideBtn");
  if (cancelSearch) {
    cancelSearch.addEventListener("click", () => cancelCurrentRide());
  }
  // Bouton dans l'Ã©tat "accepted"
  const cancelAccepted = document.getElementById("cancelRideBtnDriver");
  if (cancelAccepted) {
    cancelAccepted.addEventListener("click", () => cancelCurrentRide());
  }
}

async function cancelCurrentRide() {
  if (!currentRideId) {
    updateRideStatusMessage("Aucune course à annuler.");
    return;
  }
  const ok = window.confirm("Annuler cette course ?");
  if (!ok) return;

  try {
    const response = await fetch(`${CLIENT_API_BASE}/client/cancel_ride.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ride_id: currentRideId })
    });
    const result = await response.json();

    if (result.status === "success") {
      currentRideId = null;
      rideAccepted  = false;
      if (rideStatusCheckInterval) clearInterval(rideStatusCheckInterval);
      if (driverStatusInterval)    clearInterval(driverStatusInterval);

      onRideCancelled();
      showToast("Course annulée");
      await loadUserRides(); // rafraÃ®chir historique
    } else {
      showToast(result.message || "Annulation impossible.");
    }
  } catch (e) {
    console.error("Annulation:", e);
    showToast("Erreur lors de l'annulation.");
  }
}

// â”€â”€ RAFRAÃŽCHIR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initRefreshBtn() {
  const btn = document.getElementById("refreshMapBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (currentRideId) checkRideStatus(true);
    else showToast("Aucune course active.");
  });
}

// â”€â”€ SESSION UTILISATEUR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function initUserSession() {
  try {
    const res    = await fetch(`${CLIENT_API_BASE}/common/current_user.php`);
    const result = await res.json();

    if (res.status === 401) { window.location.href = "login.html"; return; }

    if (result.status === "success") {
      const name = result.user?.name || "Utilisateur";
      AppState.currentUser = result.user;

      // Nom dans le panel carte
      const nameEl = document.getElementById("currentUserName");
      if (nameEl) nameEl.textContent = name;

      // Avatar initiale
      const initial = name.charAt(0).toUpperCase();
      ["userInitial", "profileInitial"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = initial;
      });

      // Panel profil
      const profileName = document.getElementById("profileName");
      const infoName    = document.getElementById("infoName");
      if (profileName) profileName.textContent = name;
      if (infoName)    infoName.textContent    = name;
      setText("profileInfoName", name);
      setText("profileInfoPhone", result.user?.phone || "-");
      setText("profileInfoEmail", result.user?.email || "-");
      setText("profileInfoStatus", result.user?.status === "active" ? "Actif" : (result.user?.status || "-"));
    }
  } catch (e) {
    console.error("Session:", e);
  }

  // Logout (carte)
  document.getElementById("logoutBtn")?.addEventListener("click", doLogout);
  // Logout (profil)
  document.getElementById("logoutBtnProfile")?.addEventListener("click", doLogout);
}

async function doLogout() {
  try {
    await fetch(`${CLIENT_API_BASE}/common/logout.php`, { method: "POST" });
  } finally {
    window.location.href = "login.html";
  }
}

// â”€â”€ ONGLETS PROFIL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initProfileTabs() {
  document.getElementById("historyBtn")?.addEventListener("click", async () => {
    const panel = document.getElementById("historyPanel");
    panel?.classList.remove("hidden");
    requestAnimationFrame(() => panel?.classList.add("visible"));
    await loadUserRides();
  });

  document.getElementById("backToMapBtn")?.addEventListener("click", () => {
    const panel = document.getElementById("historyPanel");
    panel?.classList.remove("visible");
    setTimeout(() => panel?.classList.add("hidden"), 300);
  });

  const tabs   = document.querySelectorAll(".profile-tab");
  const panels = document.querySelectorAll(".profile-panel");

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t   => t.classList.remove("active"));
      panels.forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      const target = document.getElementById(`ptab${capitalize(tab.dataset.ptab)}`);
      if (target) target.classList.add("active");

      if (tab.dataset.ptab === "history") loadUserRides();
    });
  });
}

// â”€â”€ HISTORIQUE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function displayRides() {
  const container = document.getElementById("ridesContainer");
  if (!container) return;

  const history = userRides.filter(r =>
    ["completed", "cancelled", "cancelled_client"].includes(r.status)
  );

  if (history.length === 0) {
    container.innerHTML = "<p style='color:#94a3b8;font-size:13px;padding:8px 0;'>Aucune course terminée.</p>";
    return;
  }

  const labelMap = { completed: "Terminée", cancelled_client: "Annulée (client)", cancelled: "Annulée (chauffeur)" };

  container.innerHTML = history.map(ride => `
    <div class="ride-item" onclick="viewRideOnMap(${ride.id})">
      <div class="details">
        <strong>${ride.pickup} -> ${ride.destination}</strong>
        <div>${ride.distance_km} km · ${ride.price_fcfa} FCFA · ${ride.passengers} passager(s)</div>
        <div>${new Date(ride.created_at).toLocaleString("fr-FR")}</div>
      </div>
      <span class="status ${ride.status}">${labelMap[ride.status] || ride.status}</span>
    </div>
  `).join("");
}

function viewRideOnMap(rideId) {
  const ride = userRides.find(r => r.id == rideId);
  if (!ride) return;
  switchTab("map");
  displayRideOnMap(ride);
}

async function displayRideOnMap(ride) {
  [routeLayer, pickupMarker, destinationMarker, driverPositionMarker, driverRouteLayer].forEach(layer => {
    if (layer) map.removeLayer(layer);
  });
  routeLayer = pickupMarker = destinationMarker = driverPositionMarker = driverRouteLayer = null;

  pickupCoords      = { lat: ride.pickup_lat,      lng: ride.pickup_lng };
  destinationCoords = { lat: ride.destination_lat, lng: ride.destination_lng };

  pickupMarker      = L.marker([pickupCoords.lat, pickupCoords.lng]).addTo(map).bindPopup(`Départ: ${ride.pickup}`);
  destinationMarker = L.marker([destinationCoords.lat, destinationCoords.lng]).addTo(map).bindPopup(`Arrivée: ${ride.destination}`);

  await drawRouteOnMap(pickupCoords, destinationCoords);

  map.fitBounds(L.latLngBounds([
    [pickupCoords.lat, pickupCoords.lng],
    [destinationCoords.lat, destinationCoords.lng]
  ]), { padding: [30, 30] });
}

// â”€â”€ TOAST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showToast(msg, duration = 2500) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove("hidden");
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.classList.add("hidden"), 300);
  }, duration);
}


// Appelée lorsque le statut "started" est détecté
function onRideStarted(rideData) {
    if (AppState.rideState === "started") return;
    AppState.rideState = "started";
    syncAppMode();
    removeArrivedNotice();

    // Modifier l'UI du panneau Course
    const rideTitle = document.querySelector("#rideAcceptedMsg .ride-state-title");
    if (rideTitle) rideTitle.textContent = "Course en cours 🚗";
    const rideSub = document.getElementById("rideStatusMessage");
    if (rideSub) rideSub.textContent = "Course en cours";

    // Désactiver l'affichage du temps d'arrivée et distance du départ
    const etaElements = document.querySelectorAll(".driver-eta");
    etaElements.forEach(el => {
        el.style.display = "none";
    });

    // Cacher les boutons d'appel / message / annuler
    const callBtn = document.getElementById("driverCallBtn");
    const msgBtn = document.getElementById("driverMsgBtn");
    const cancelBtn = document.getElementById("cancelRideBtnDriver");
    if (callBtn) callBtn.style.display = "none";
    if (msgBtn) msgBtn.style.display = "none";
    if (cancelBtn) cancelBtn.style.display = "none";

    // Afficher le bouton "Signaler un problème"
    const reportBtn = document.getElementById("reportProblemBtn");
    if (reportBtn) reportBtn.style.display = "flex";

    // Masquer le bloc ETA chauffeur pendant le trajet
    const liveDiv = document.getElementById("driverLiveInfo");
    if (liveDiv) liveDiv.style.display = "none";

    // Démarrer le suivi temps réel du trajet
    startRideProgressTracking();
}

function onRideArrived(rideData) {
    if (AppState.rideState === "arrived") return;
    AppState.rideState = "arrived";
    syncAppMode();

    const driver = rideData?.driver || {};
    const info = {
        name:    driver.name   || "Votre chauffeur",
        color:   driver.color  || "",
        plate:   driver.plate  || "-",
        rating:  driver.rating || "4.8",
        phone:   driver.phone  || ""
    };

    setDriverInfo(info);
    AppState.currentDriver = info;
    setRideState("accepted");

    const rideTitle = document.querySelector("#rideAcceptedMsg .ride-state-title");
    if (rideTitle) rideTitle.textContent = "Le chauffeur est arrivé";

    updateRideStatusMessage("Votre chauffeur vous attend au point de départ.");
    showArrivedNotice();

    document.querySelectorAll(".driver-eta").forEach(el => {
        el.style.display = "none";
    });

    const reportBtn = document.getElementById("reportProblemBtn");
    if (reportBtn) reportBtn.style.display = "none";

    const callBtn = document.getElementById("driverCallBtn");
    const msgBtn = document.getElementById("driverMsgBtn");
    const cancelBtn = document.getElementById("cancelRideBtnDriver");
    if (callBtn) callBtn.style.display = "flex";
    if (msgBtn) msgBtn.style.display = "flex";
    if (cancelBtn) cancelBtn.style.display = "flex";

    if (etaUpdateInterval) clearInterval(etaUpdateInterval);
    const liveDiv = document.getElementById("driverLiveInfo");
    if (liveDiv) liveDiv.style.display = "none";

    switchTab("ride");
}

function showArrivedNotice() {
    const panel = document.getElementById("rideAcceptedMsg");
    if (!panel || document.getElementById("rideArrivedNotice")) return;

    const notice = document.createElement("div");
    notice.id = "rideArrivedNotice";
    notice.className = "ride-arrived-notice";
    notice.textContent = "Le chauffeur est sur place. Vous pouvez le rejoindre au point de départ.";

    const status = document.getElementById("rideStatusMessage");
    if (status && status.nextSibling) {
        panel.insertBefore(notice, status.nextSibling);
    } else {
        panel.appendChild(notice);
    }
}

function removeArrivedNotice() {
    document.getElementById("rideArrivedNotice")?.remove();
}

// Démarre le suivi de la position du chauffeur pour afficher ETA / distance
function startDriverLiveTracking(rideData) {
    const liveDiv = document.getElementById("driverLiveInfo");
    if (liveDiv) liveDiv.style.display = "block";

    // Initialiser la position à partir des données reçues
    if (rideData.driver && rideData.driver.lat && rideData.driver.lng) {
        currentDriverPosition = {
            lat: rideData.driver.lat,
            lng: rideData.driver.lng
        };
    }

    async function updateLiveETA() {
        await updateLiveETAFromCurrentPosition();
    }

    if (etaUpdateInterval) clearInterval(etaUpdateInterval);
    etaUpdateInterval = setInterval(updateLiveETA, 5000);
    updateLiveETA(); // premier appel immédiat
}


/* ============================================================
   SUIVI TEMPS RÉEL DE LA COURSE
============================================================ */

async function updateRideProgress() {
    if (!pickupCoords || !destinationCoords) return;

    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${pickupCoords.lng},${pickupCoords.lat};${destinationCoords.lng},${destinationCoords.lat}?overview=false`;

        const response = await fetch(url);
        const data = await response.json();

        if (!data.routes || !data.routes.length) return;

        const route = data.routes[0];

        const distanceKm = (route.distance / 1000).toFixed(1);
        const durationMin = Math.round(route.duration / 60);

        const distanceEl = document.getElementById("routeDistance");
        const durationEl = document.getElementById("routeDuration");

        if (distanceEl) distanceEl.textContent = `${distanceKm} km`;
        if (durationEl) durationEl.textContent = `${durationMin} min`;

        const pillDistance = document.getElementById("pillDistance");
        const pillDuration = document.getElementById("pillDuration");

        if (pillDistance) pillDistance.textContent = `${distanceKm} km`;
        if (pillDuration) pillDuration.textContent = `${durationMin} min`;

    } catch (error) {
        console.error("Erreur suivi progression course :", error);
    }
}

function startRideProgressTracking() {
    if (etaUpdateInterval) clearInterval(etaUpdateInterval);

    etaUpdateInterval = setInterval(() => {
        if (AppState.rideState === "started") {
            updateRideProgress();
        }
    }, 5000);

    updateRideProgress();
}


// Modifier la fonction onRideCompleted pour afficher un message en grand
function onRideCompleted() {
    AppState.rideState = "idle";
    currentRideId = null;
    rideAccepted = false;
    AppState.currentDriver = null;

    if (etaUpdateInterval) clearInterval(etaUpdateInterval);

    // Afficher un modal ou une grande notification
    showCompletionMessage();

    $navBtns.ride.disabled = true;
    syncAppMode();
    setTimeout(() => {
        switchTab("map");
        resetMapPanel();
    }, 3000);
}

function showCompletionMessage() {
    // Créer un overlay temporaire
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.backgroundColor = "rgba(0,0,0,0.8)";
    overlay.style.zIndex = "10000";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.flexDirection = "column";
    overlay.style.color = "white";
    overlay.style.fontSize = "2rem";
    overlay.style.fontWeight = "bold";
    overlay.innerHTML = `
        <div style="text-align: center; background: #1f2937; padding: 2rem; border-radius: 20px;">
            <div style="font-size: 4rem;">✅</div>
            <div>Course terminée !</div>
            <div style="font-size: 1rem; margin-top: 1rem;">Merci d'avoir voyagé avec TaxiGo</div>
        </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 3000);
}

// Modifier onRideAccepted pour cacher le bouton report si jamais (par sécurité)
function onRideAccepted(driverData) {
    if (AppState.rideState === "accepted") return;
    AppState.rideState = "accepted";
    syncAppMode();
    removeArrivedNotice();

    let info;
    if (typeof driverData === "object" && driverData !== null) {
        info = {
            name:    driverData.name   || "Votre chauffeur",
            color:   driverData.color  || "",
            plate:   driverData.plate  || "-",
            rating:  driverData.rating || "4.8",
            phone:   driverData.phone  || ""
        };
    } else {
        const statusMsg  = String(driverData || "");
        const nameMatch  = statusMsg.match(/par\s+([^(]+?)\s*(\(|$)/);
        const plateMatch = statusMsg.match(/\(([^)]+)\)/);
        info = {
            name:    nameMatch  ? nameMatch[1].trim()  : "Votre chauffeur",
            plate:   plateMatch ? plateMatch[1].trim() : "-",
            color: "",
            rating:  "4.8"
        };
    }

    // ✅ AJOUT CRITIQUE : afficher les infos du chauffeur
    setDriverInfo(info);

    AppState.currentDriver = info;
    setRideState("accepted");
    const rideTitle = document.querySelector("#rideAcceptedMsg .ride-state-title");
    if (rideTitle) rideTitle.textContent = "Chauffeur en route";
    updateRideStatusMessage("Le chauffeur arrive");

    document.querySelectorAll(".driver-eta").forEach(el => {
        el.style.display = "";
    });

    // Cacher le bouton "Signaler un problème" si visible
    const reportBtn = document.getElementById("reportProblemBtn");
    if (reportBtn) reportBtn.style.display = "none";

    // Réafficher les boutons d'appel / message / annuler
    const callBtn = document.getElementById("driverCallBtn");
    const msgBtn = document.getElementById("driverMsgBtn");
    const cancelBtn = document.getElementById("cancelRideBtnDriver");
    if (callBtn) callBtn.style.display = "flex";
    if (msgBtn) msgBtn.style.display = "flex";
    if (cancelBtn) cancelBtn.style.display = "flex";

    // Arrêter l’ancien suivi ETA (si existant) et cacher l'info live
    if (etaUpdateInterval) clearInterval(etaUpdateInterval);
    const liveDiv = document.getElementById("driverLiveInfo");
    if (liveDiv) liveDiv.style.display = "none";

    switchTab("ride");
    showToast(`🚕 ${info.name} arrive !`);
}

// Ajouter l'écouteur pour le bouton "Signaler un problème"
function initReportProblem() {
    const btn = document.getElementById("reportProblemBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
        if (!currentRideId) return;
        const problem = prompt("Décrivez le problème rencontré :");
        if (!problem) return;
        fetch(`${CLIENT_API_BASE}/client/report_problem.php`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ride_id: currentRideId, problem: problem })
        })
        .then(res => res.json())
        .then(data => {
            if (data.status === "success") {
                showToast("Problème signalé, merci.");
            } else {
                showToast("Erreur lors de l'envoi.");
            }
        })
        .catch(() => showToast("Erreur réseau."));
    });
}

// Appelée à chaque polling (checkRideStatus) pour mettre à jour la position chauffeur
function onRideStatusUpdate(rideData) {
    if (!rideData || !rideData.driver) return;

    // Mettre à jour la position globale
    if (rideData.driver.lat && rideData.driver.lng) {
        currentDriverPosition = {
            lat: rideData.driver.lat,
            lng: rideData.driver.lng
        };
    }

    // Si la course est en "started" et que l'affichage ETA est actif, on rafraîchit
    if (AppState.rideState === "started") {
        const liveDiv = document.getElementById("driverLiveInfo");
        if (liveDiv && liveDiv.style.display !== "none") {
            updateLiveETAFromCurrentPosition();
        }
    }
}

// Recalcule l’ETA à partir de la dernière position connue du chauffeur
async function updateLiveETAFromCurrentPosition() {
    if (!currentDriverPosition.lat || !currentDriverPosition.lng) return;
    if (!pickupCoords) return;

    const url = `https://router.project-osrm.org/route/v1/driving/${currentDriverPosition.lng},${currentDriverPosition.lat};${pickupCoords.lng},${pickupCoords.lat}?overview=false`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.routes && data.routes.length) {
            const distanceM = data.routes[0].distance;
            const durationSec = data.routes[0].duration;
            const km = (distanceM / 1000).toFixed(1);
            const minutes = Math.round(durationSec / 60);
            document.getElementById("liveDistance").textContent = `${km} km`;
            document.getElementById("liveETA").textContent = `${minutes} min`;
        } else {
            document.getElementById("liveDistance").textContent = "Calcul...";
            document.getElementById("liveETA").textContent = "--";
        }
    } catch (e) {
        console.warn("Erreur calcul ETA temps réel", e);
    }
}
// â”€â”€ UTILS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
